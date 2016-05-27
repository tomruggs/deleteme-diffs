/**
 * This module holds tasks that need to be scheduled for running on occasion.
 */
'use strict';

const
  aws = require('aws-sdk'),
  later = require('later'),
  os = require('os'),
  async = require('async'),
  exec = require('child_process').exec;

// Use the local time zone for parsing later schedules. Otherwise it defaults
// to UTC and things get weird.
later.date.localTime();

const
  config = require('./config/config.js'),
  gitGcScript = require('./bin/git_gc.js'),
  logger = require('./util/logger.js'),

  awsConfig = require(config.awsConfigPath),

  // Strings that can be parsed by the later module to be used for scheduling tasks.
  TIMES = {
    GIT_GC: {
      production: 'at 2:00 am on Saturday on the 2 week of the month and ' +
        'at 2:00 am on Saturday on the 4 week of the month',
      staging: 'at 2:00 am on Saturday on the 3 week of the month',
      qa: 'at 2:00 am on Saturday on the 1 week of the month',
      development: 'every 5 min'
      // There is no expected interval to test here, because calendar arithmetic is massive pain
    },
    EBS_SNAPSHOT: {
      production: 'at 12:15am',
      test: {
        expectedInterval: 24 * 60 * 60 * 1000
      }
    },
    SYSTEM_DATA: {
      production: '*/10 * * * *', // every 10 minutes
      staging: '*/10 * * * *', // every 10 minutes
      qa: '*/10 * * * *', // every 10 minutes
      development: '*/10 * * * *', // every 10 minutes
      test: {
        expectedInterval: 10 * 60 * 1000
      }
    },
    NFS_STAT: {
      production: '*/60 * * * *', // every 60 minutes
      staging: '*/60 * * * *', // every 60 minutes
      qa: '*/60 * * * *', // every 60 minutes
      development: '*/60 * * * *', // every 60 minutes
      test: {
        expectedInterval: 60 * 60 * 1000
      }
    }
  },

  /**
   * Schedules the creation of an EBS snapshot based on the TIMES.EBS_SNAPSHOT value above..
   */
  ebsSnapshots = function () {
    var laterSched,
    // The time when the backup was performed
      backupTimestamp,
      ec2Client;

    // Only configure the snapshot scheduler if we're in production.
    if (config.env == 'production') {
      logger.debug('Production environment detected, creating EBS Snapshot Scheduler.');
      // Client for the ec2 aws-sdk
      ec2Client = new aws.EC2(new aws.Config(awsConfig));

      laterSched = later.parse.text(TIMES.EBS_SNAPSHOT[config.env]);
      later.setInterval(function () {
        backupTimestamp = new Date().toJSON();

        ec2Client.createSnapshot(
          {
            'DryRun': false,
            'VolumeId': 'vol-dee96908',
            'Description': 'softnas-primary-' + backupTimestamp
          },
          function (err, data) {
            if (err) {
              logger.error('Error creating EBS Snapshot for SoftNAS: ', err);
            } else {
              logger.debug('SoftNAS EBS Snapshot completed successfully: ', data);
            }
          });

        ec2Client.createSnapshot(
          {
            'DryRun': false,
            'VolumeId': 'vol-275e1dfb',
            'Description': 'softnas-secondary-' + backupTimestamp
          },
          function (err, data) {
            if (err) {
              logger.error('Error creating EBS Snapshot for SoftNAS: ', err);
            } else {
              logger.debug('SoftNAS EBS Snapshot completed successfully: ', data);
            }
          });
      }, laterSched);
    } else {
      logger.debug('Skipping EBS Snapshot Scheduler because the env is ' + config.env);
    }
  },

  /**
   * Schedules a task to run git gc.  Deciding if this instance is the primary is intentionally left
   * up to the git_gc.js module since ASG membership may change while this instance is running.
   */
  gitGc = function() {
    var laterSched;

    if (config.env === 'development' && !process.env.RUN_GIT_GC) {
      logger.debug('Not scheduling git gc for development server.');
      return;
    }

    logger.debug('Scheduled git gc for ' + TIMES.GIT_GC[config.env]);
    laterSched = later.parse.text(TIMES.GIT_GC[config.env]);
    later.setInterval(function () {
      gitGcScript(function(error) {
        if (error) {
          logger.error('An error occurred while running the git gc script.', error);
        }
      });
    }, laterSched);
  },

  /**
   * Schedules system data being logged out to help aid with debugging issues.
   * FIXME: move to a shared module so that all services can use then.  Then also
   * send info to Datadog and create graphs
   */
  systemData = function() {
    var laterSched = later.parse.cron(TIMES.SYSTEM_DATA[config.env]);
    later.setInterval(function () {
      var
        memory = process.memoryUsage(),
        data = {
          freeMemory: Math.round(os.freemem() / 1048576) + 'MB',
          heapTotal: Math.round(memory.heapTotal / 1048576) + 'MB',
          heapUsed: Math.round(memory.heapUsed / 1048576) + 'MB'
        };

      async.waterfall([
        // find total process count
        function(next) {
          exec('ps aux | wc -l', null, function (error, stdout, stderror) {
            data.processes = stdout ? stdout.trim() : '';
            next(error);
          });
        },

        // find open file count
        function(next) {
          exec('lsof | wc -l', null, function (error, stdout, stderror) {
            data.openFiles = stdout ? stdout.trim() : '';
            next(error);
          });
        }],
        function(err) {
          if (err) {
            logger.debug('Error in debugData: ' + err);
          }
          logger.debug(data);
        }
      );
    }, laterSched);
  },

  /**
   * Schedules NFS data being logged out to help aid with debugging issues.  This is
   * separated from system data because it is very verbose.
   *
   * FIXME: nfsstat output should be parsed and simplified as much as possible.  (There is
   * no existing JS library for this.)  If it's a lot more compact, consider moving into
   * systemData() to run more regularly.  This data should also be sent to Datadog.
   */
  nfsStat = function() {
    var laterSched = later.parse.cron(TIMES.NFS_STAT[config.env]);
    later.setInterval(function () {
      exec('nfsstat -c', null, function (error, stdout, stderror) {
        if (error) {
          logger.debug('Error in nfsstat: ' + error);
        }
        logger.debug('nfsstat: ' + stdout);
      });
    }, laterSched);
  },
  /**
   * Schedules all tasks.
   */
  initScheduledTasks = function() {
    ebsSnapshots();
    gitGc();
    systemData();
    nfsStat();
  };

module.exports = {
  initScheduledTasks: initScheduledTasks,
  // Read only copy for testing
  TIMES: JSON.parse(JSON.stringify(TIMES))
};
