/* jshint -W097 */
/* jshint -W030 */
/* jshint strict:true */
/* jslint node: true */
/* jslint esversion: 6 */
'use strict';


const Shelly = require('shelly-iot');
const net = require('net');
const request = require('request');
const datapoints = require(__dirname + '/datapoints');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isAsync(funct) {
  if (funct && funct.constructor) return funct.constructor.name == 'AsyncFunction';
  return undefined;
}

function requestAsync(url) {
  return new Promise((resolve, reject) => {
    request(url, (error, res, body) => {
      if (!error && body) {
        resolve(body);
      } else {
        reject(error);
      }
    });
  });
}

function recursiveSubStringReplace(source, pattern, replacement) {
  function recursiveReplace(objSource) {
    switch (typeof objSource) {
      case 'string':
        return objSource.replace(pattern, replacement);
      case 'object':
        if (objSource === null) {
          return null;
        }
        Object.keys(objSource).forEach(function (property) {
          objSource[property] = recursiveReplace(objSource[property]);
        });
        return objSource;
      default:
        return objSource;
    }
  }
  return recursiveReplace(source);
}



class CoAPClient {
  constructor(adapter, objectHelper, shelly, deviceId, ip) {
    this.adapter = adapter;
    this.objectHelper = objectHelper;
    this.shelly = shelly;
    this.deviceId = deviceId;
    this.ip = ip;
    this.states = {};
    this.device = {};
    this.http = {};
    this.auth;
    if (this.adapter.config.http_username.length > 0 && this.adapter.config.http_password.length > 0)
      this.auth = 'Basic ' + new Buffer(this.adapter.config.http_username + ':' + this.adapter.config.http_password).toString('base64');
    this.createObjects();
    this.listen();
  }

  listen() {
    this.adapter.log.info('Shelly device ' + this.getName() + ' with CoAP connected!');
    this.shelly.on('update-device-status', (deviceId, status) => {
      if (deviceId === this.deviceId) {
        this.createIoBrokerState(status);
      }
    });
  }

  getDeviceType() {
    let devicetype = this.deviceId.split('#').slice(0, 1).join();
    return devicetype;
  }

  getDeviceId() {
    let devicetype = this.deviceId.split('#');
    let deviceid;
    if (devicetype) deviceid = devicetype[1];
    return deviceid;
  }

  getName() {
    let name;
    if (this.deviceId) name = this.deviceId;
    if (this.ip) name = this.ip + ' (' + name + ')';
    return name;
  }


  getDeviceName() {
    return this.deviceId;
  }

  getIP() {
    return this.ip;
  }

  createObjects() {
    let id = this.getDeviceType(this.deviceId);
    id = datapoints.getDeviceNameForCoAP(id);
    if (Object.keys(this.device).length === 0) {
      let all = datapoints.getAll();
      for (let i in all) {
        if (id === i) {
          let devices = all[i];
          devices = recursiveSubStringReplace(devices, new RegExp('<deviceid>', 'g'), this.getDeviceId());
          for (let j in devices) {
            let statename = j;
            let state = devices[j];
            state.state = j;
            let deviceid = this.getDeviceName();
            if (!this.states[deviceid] || this.states[deviceid] !== deviceid) {
              this.states[deviceid] = deviceid;
              this.objectHelper.setOrUpdateObject(deviceid, {
                type: 'device',
                common: {
                  name: 'Device ' + deviceid
                },
                native: {}
              }, ['name']);
            }
            let channel = statename.split('.').slice(0, 1).join();
            if (channel !== statename) {
              let channelid = deviceid + '.' + channel;
              if (!this.states[channelid] || this.states[channelid] !== channelid) {
                this.states[channelid] = channelid;
                this.objectHelper.setOrUpdateObject(channelid, {
                  type: 'channel',
                  common: {
                    name: 'Channel ' + channel
                  }
                }, ['name']);
              }
            }
            let stateid = deviceid + '.' + statename;
            let controlFunction;
            if (state.coap && state.coap.http_cmd && !state.coap.coap_cmd) {
              controlFunction = async (value) => {
                value = state.coap.http_cmd_funct ? state.coap.http_cmd_funct(value) : value;
                if (typeof value === 'object') {
                  for (let i in value) {
                    if (typeof value[i] === 'function') {
                      try {
                        value[i] = isAsync(value[i]) ? await value[i](this) : value[i](this);
                        if (!value[i]) delete value[i];
                      } catch (error) {
                        delete value[i];
                      }
                    }
                  }
                }
                try {
                  let params;
                  if (this.auth) {
                    params = {
                      url: 'http://' + this.getIP() + state.coap.http_cmd,
                      qs: value,
                      headers: {
                        'Authorization': this.auth
                      }
                    };
                  } else {
                    params = {
                      url: 'http://' + this.getIP() + state.coap.http_cmd,
                      qs: value
                    };
                  }
                  this.adapter.log.debug('Call url ' + JSON.stringify(params) + ' for ' + this.getName());
                  let body = await requestAsync(params);
                } catch (error) {
                  /* */
                }
                delete this.states[stateid];
              };
            }
            if (state.coap && state.coap.http_publish && !state.coap.coap_publish) {
              if (!this.http[state.coap.http_publish]) this.http[state.coap.http_publish] = [];
              this.http[state.coap.http_publish].push(statename);
            }
            let value;
            if(state.coap.coap_init_value) value = state.coap.coap_init_value;
            this.objectHelper.setOrUpdateObject(stateid, {
              type: 'state',
              common: state.common
            }, ['name'], value, controlFunction);
          }
          this.device = devices;
        }
      }
      this.objectHelper.processObjectQueue(() => { });
    }
    this.httpIoBrokerState();
  }

  createIoBrokerState(payload) {
    for (let i in this.device) {
      let dp = this.device[i];
      let deviceid = this.getDeviceName();
      let stateid = deviceid + '.' + dp.state;
      if (dp.coap && dp.coap.coap_publish_funct) {
        let value = dp.coap.coap_publish_funct(payload);
        if (!this.states.hasOwnProperty(stateid) || this.states[stateid] !== value) {
          this.states[stateid] = value;
          this.objectHelper.setOrUpdateObject(stateid, {
            type: 'state',
            common: dp.common
          }, ['name'], value);
          this.objectHelper.processObjectQueue(() => { });
        }
      }
    }
  }

  async httpIoBrokerState() {
    for (let i in this.http) {
      let params = { url: 'http://' + this.getIP() + i };
      let states = this.http[i];
      try {
        if (this.auth) {
          params = {
            url: 'http://' + this.getIP() + i,
            headers: {
              'Authorization': this.auth
            }
          };
        } else {
          params = {
            url: 'http://' + this.getIP() + i
          };
        }
        this.adapter.log.debug('Call url ' + JSON.stringify(params) + ' for ' + this.getName());
        let body = await requestAsync(params);
        for (let j in states) {
          let state = this.device[states[j]];
          let deviceid = this.getDeviceName();
          let stateid = deviceid + '.' + state.state;
          let value = state.coap && state.coap.http_publish_funct ? state.coap.http_publish_funct(body) : body;
          if (!this.states.hasOwnProperty(stateid) || this.states[stateid] !== value) {
            this.states[stateid] = value;
            this.objectHelper.setOrUpdateObject(stateid, {
              type: 'state',
              common: state.common
            }, ['name'], value);
          }
        }
        this.objectHelper.processObjectQueue(() => { });
      } catch (error) { /* */ }
    }
    if (this.http && Object.keys(this.http).length > 0) {
      await sleep(5 * 1000);
      await this.httpIoBrokerState();
    }
  }

}

class CoAPServer {

  constructor(adapter, objectHelper) {
    if (!(this instanceof CoAPServer)) return new CoAPServer(adapter, objectHelper);
    this.adapter = adapter;
    this.objectHelper = objectHelper;
    this.clients = {};
  }

  listen() {
    let options = {};
    if (this.adapter.config.user && this.adapter.config.password) {
      options = {
        logger: this.adapter.log.debug,
        user: this.adapter.config.http_username,
        password: this.adapter.config.http_password
      };
    } else {
      options = {
        logger: this.adapter.log.debug,
      };
    }
    let shelly = new Shelly(options);

    shelly.on('update-device-status', (deviceId, status) => {
      this.adapter.log.debug('Status update received for ' + deviceId + ': ' + JSON.stringify(status));
      if (deviceId && typeof deviceId === 'string') {
        if (!this.clients[deviceId]) {
          shelly.getDeviceDescription(deviceId, (err, deviceId, description, ip) => {
            if (!err && deviceId && ip) {
              this.clients[deviceId] = new CoAPClient(this.adapter, this.objectHelper, shelly, deviceId, ip);
              this.clients[deviceId].createIoBrokerState(status);
            }
          });
        }

        /*
        if (!knownDevices[deviceId]) { // device unknown so far, new one in network, create it
          shelly.getDeviceDescription(deviceId, (err, deviceId, description, ip) => {
            knownDevices[deviceId] = {
              ts: 0,
              mode: undefined
            };
            createShellyStates(deviceId, description, ip, status);
            updateShellyStates(deviceId, status);
            if (!deviceId.startsWith('SHHT')) {
              pollStates(deviceId);
            }
            objectHelper.processObjectQueue(() => {
              adapter.log.debug('Initialize device ' + deviceId + ' (' + Object.keys(knownDevices).length + ' now known)');
            }); // if device is added later, create all objects
          });
          return;
        }
        updateShellyStates(deviceId, status);
        objectHelper.processObjectQueue(() => { });
        */
      } else {
        this.adapter.log.debug('Device Id is missing ' + deviceId);
      }
    });

    shelly.on('device-connection-status', (deviceId, connected) => {
      this.adapter.log.debug('Connection update received for ' + deviceId + ': ' + connected);
      /*
      if (knownDevices[deviceId]) {
        adapter.setState(deviceId + '.online', connected, true);
      }
      */
    });

    shelly.on('error', (err) => {
      this.adapter.log.info('Error handling Shelly data: ' + err);
    });

    shelly.on('disconnect', () => {
      /*
      if (!isStopped) {
        setConnected(false);
        adapter.log.info('Reconnecting ...');
        setTimeout(() => {
          shelly.listen(() => {
            setConnected(true);
          });
        }, 2000);
      }
      */
    });

    shelly.listen(() => {
      this.adapter.log.info('Listening for Shelly packets in the network');
    });
  }

}

module.exports = {
  CoAPServer: CoAPServer
};