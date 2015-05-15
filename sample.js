//callClient.js

function CallClient (fs) {
    this.fs = fs;
}

CallClient.prototype.conferenceBridge = function (conferenceId, fn) {
    var multiCallClient = this.pipeline(),
        joinConference = multiCallClient.conference.bind(multiCallClient, conferenceId);

    return {
        join: function (uuid) {
            joinConference(uuid);
            return this;
        },
        exec: function () {
            return multiCallClient.exec(fn);
        },
        execAsync: function () {
            return multiCallClient.execAsync();
        }
    };
};

CallClient.prototype.setVariables = function (uuid, variables, fn) {

    let variablesString = Object.keys(variables).reduce((keyValues, key) => {
        var value = variables[key];
        if(value !== undefined) {
            if(keyValues.length) {
                keyValues += ';'
            }
            keyValues += key + '=' + value;
        }
        return keyValues;
    }, '');

    return this.bgapi('uuid_setvar_multi ' + uuid + ' ' + variablesString, fn);
};

CallClient.prototype.broadcastTone = function (uuid) {
    return this.bgapi('uuid_broadcast ' + uuid + ' playback::tone_stream://%(2000,4000,440,480);loops=-1 aleg');
};

CallClient.prototype.killUuid = function (uuid, fn) {
    return this.bgapi('uuid_kill ' + uuid, fn);
};

CallClient.prototype.mute = function (uuid, fn) {
    this.bgapi('uuid_audio ' + uuid + ' start read mute -4', fn);
};

CallClient.prototype.bgapi = function (command, fn) {
    this.fs.bgapi(command, fn);
};

CallClient.prototype.dumpUuid = function (uuid, fn) {
    this.bgapi('uuid_dump ' + uuid + ' json', function (uuidDump) {
        fn && fn(JSON.parse(uuidDump.body));
    });
};

function MultiCallClient (fs) {
    this.fs = fs;
    this.commands = [];
}

MultiCallClient.prototype = Object.create(CallClient.prototype);

MultiCallClient.prototype.bgapi = function (command) {
    this.commands.push(command);
    return this;
};

MultiCallClient.prototype.exec = function (fn) {
    var commandsExecuted = 0,
        self = this,
        commandsToExecute = self.commands,
        done;

    done = function () {
        if(commandsExecuted === commandsToExecute.length) {
            fn && fn();
        } else {
            self.fs.bgapi(commandsToExecute[commandsExecuted ++], done);
        }
    };

    done();
};

MultiCallClient.prototype.execAsync = function () {
    var self = this;
    return new Promise(function (resolve, reject) {
        //TODO reject on timeouts
        self.exec(resolve);
    });
};

makeAllAsync(CallClient.prototype);

//promisifyAll wouldn't work as this callback doesn't conform to node-style callbacks
function makeAllAsync (object) {
    Object.keys(object).forEach((method) => {
        var fn = object[method];
        if(typeof fn == 'function') {
            object[method + 'Async'] = makeAsync(method);
        }
    });
}

function makeAsync (method) {
    return function () {
        var args = [].slice.call(arguments),
            self = this;
        return new Promise(function (resolve, reject) {
            args.push(resolve);
            self[method].apply(self, args);
        });
    }
}


//TODO async timeouts for errors
module.exports = CallClient;

//callService.js

function CallService (options) {
    var eventSocket = options.eventSocket;
    this.callClient = options.callClient;
    this.redis = options.redis;
    this.onlineAgents = options.onlineAgents;
    this.c3q = options.c3q;
    this.analytics = options.analytics;
    this.listenCallEvents(eventSocket);
    this.listenQueueEvents();
}

CallService.prototype.makeCall = function (callingAgent, number, campaignCall) {
    var self = this,
        pipeline = self.redis.multi(),
        callString;

    pipeline.hgetall('user:' + callingAgent.username);
    pipeline.hgetall('group:' + callingAgent.activeGroup);

    return pipeline.execAsync().spread(function (user, callingAgentGroup) {
        var agentUuid = uuid.v1(),
            otherUuid = uuid.v1(),
            callOptions = buildCallOptions(callingAgent, callingAgentGroup, user, number, agentUuid, otherUuid),
            newCall = {uuid: otherUuid, number: number};

        setIdentityOptions(number, callOptions, newCall, callingAgent.c3Domain, self.onlineAgents);

        if(campaignCall) {
            callOptions.campaignCallId = campaignCall.uuid;
        }

        callString = interpolate(outboundDialStrings.call, callOptions);

        self.callClient.bgapi(callString); //TODO Async?
        return {call: newCall, agentUuid: agentUuid};
    });
};


CallService.prototype.conference = function (callingAgent) {
    var activeCall = callingAgent.activeCall,
        parkedCall = callingAgent.parkedCall,
        callClient = this.callClient.pipeline(),
        conferenceId,
        conferenceBridge;

    /**
     * If agent is already part of a conference bridge, add them to the existing conference
     */

    /**
     * Both agents are in conference. Move them all to a new conference. Only one of the two sides must be moved
     */
    if(activeCall.agent && activeCall.agent.inConference && parkedCall.agent && parkedCall.agent.inConference) {
        return this.mergeConference(parkedCall, activeCall, callingAgent.agentUuid);

    } else {
        //if either party is an agent and in conference, use the existing conference ID, otherwise generate a new one
        if(activeCall.agent && activeCall.agent.inConference) {
            conferenceId = activeCall.agent.conferenceId;
        } else if(parkedCall.agent && parkedCall.agent.inConference) {
            conferenceId = parkedCall.agent.conferenceId;
        } else {
            conferenceId = generateConferenceId();
        }

        conferenceBridge = callClient.conferenceBridge(conferenceId);

        if(activeCall.agent) {
            conferenceBridge.join(callingAgent.agentUuid);

            //only if the other agent's activeCall is with me
            if(!activeCall.agent.inConference && activeCall.agent.activeCall.agent === callingAgent) {
                conferenceBridge.join(activeCall.uuid); //activeAgent will already be in this conference is activeAgent is inConference
            }
        } else {
            conferenceBridge
                .join(activeCall.uuid)
                .join(callingAgent.agentUuid);
        }

        //redundant inConference check
        if(!parkedCall.agent || (parkedCall.agent.activeCall.agent === callingAgent && !parkedCall.agent.inConference)) {
            conferenceBridge.join(parkedCall.uuid);
        }

        return conferenceBridge.execAsync().then(function () {
            return conferenceId;
        });
    }
};


/**
 * Agent's trying to do a conference when both of its parties are in conference
 * Move some agents from the parked/active side to the other side
 *
 * @param leftSide not necessarily the left side
 * @param rightSide ^
 * @param thisAgentUuid
 */
CallService.prototype.mergeConference = function (leftSide, rightSide, thisAgentUuid) {
    var leftSideParties,
        rightSideParties,
        partiesToConference,
        conferenceToJoin;

    leftSideParties = collectParties(leftSide, thisAgentUuid);
    rightSideParties = collectParties(rightSide, thisAgentUuid);

    if(leftSideParties.length > rightSideParties.length) { //more members on the left side, join 'em
        conferenceToJoin = leftSide.agent.conferenceId;
        partiesToConference = rightSideParties;
    } else { //more members on the right side, join 'em. Prefer right over left for same no. of members
        conferenceToJoin = rightSide.agent.conferenceId;
        partiesToConference = leftSideParties;
    }

    partiesToConference.push({uuid: thisAgentUuid}); //!agent

    return this.conferenceParties(conferenceToJoin, partiesToConference).then(function () {
        return conferenceToJoin;
    });
};


/**
 * @internal When both parties are in a conference
 * @param leftSide
 * @param rightSide
 * @param thisAgentUuid
 * @returns a promise that's resolved when members from both sides have been put into a conference bridge
 */
CallService.prototype.splitConference = function (leftSide, rightSide, thisAgentUuid) {
    var leftSideParties = collectParties(leftSide, thisAgentUuid),
        rightSideParties = collectParties(rightSide, thisAgentUuid),
        leftSideNewConferenceId = generateConferenceId(),
        rightSideNewConferenceId = generateConferenceId(),
        self = this;


    return Promise.all(self.conferenceParties(leftSideNewConferenceId, leftSideParties), self.conferenceParties(rightSideNewConferenceId, rightSideParties));
};

CallService.prototype.conferenceParties = function (conferenceToJoin, partiesToConference) {
    var conferenceBridge = this.callClient.conferenceBridge(conferenceToJoin);

    partiesToConference.forEach(function (partyToConference) {
        if(partyToConference.agent) { //assert partyToConference.agent.inConference to be true
            partyToConference.agent.conferenceId = conferenceToJoin; //update their conference ID only if they had a conference
        }
        conferenceBridge.join(partyToConference.uuid);
    });

    return conferenceBridge.execAsync();
};

/**
 * Kill me
 * If both of my legs are agents, move both sides to a new conference
 * @param thisAgent
 */
CallService.prototype.endConference = function (thisAgent) {
    var agentUuid = thisAgent.agentUuid,
        firstCall = thisAgent.firstCall,
        secondCall = thisAgent.secondCall,
        self = this,
        clearOtherCalls;

    clearOtherCalls = function () {
        self.clearOtherCall(thisAgent.firstCall, agentUuid);
        self.clearOtherCall(thisAgent.secondCall, agentUuid);
    };

    if(firstCall.agent && firstCall.agent.inConference && secondCall.agent && secondCall.agent.inConference) {
        this.splitConference(firstCall, secondCall, agentUuid).then(clearOtherCalls); //don't wait for it to complete. thisAgent is not affected by this
    } else {
        clearOtherCalls();
    }

    return self.callClient.killUuidAsync(agentUuid);
};

CallService.prototype.swap = function (thisAgent) {
    var activeCall = thisAgent.activeCall,
        parkedCall = thisAgent.parkedCall,
        multiCallClient = this.callClient.pipeline();


    //If the active call is with a PSTN or an agent whose active call is with this agent, park them
    if(!activeCall.agent) {
        multiCallClient.valetPark(activeCall.uuid);
    }

    if(parkedCall.agent && parkedCall.agent.inConference) {
        multiCallClient.conference(parkedCall.agent.conferenceId, thisAgent.agentUuid);
    } else if(!parkedCall.agent || (parkedCall.agent && parkedCall.agent.activeCall.agent === thisAgent)) {
        multiCallClient.bridgeUuids(thisAgent.agentUuid, parkedCall.uuid);
    } else { //parked call is an agent whose active call is not this one
        multiCallClient.valetPark(thisAgent.agentUuid);
    }

    //put the active agent on valet only after conferencing has finished
    if(activeCall.agent && !activeCall.agent.inConference && activeCall.agent.activeCall.agent === thisAgent) {
        multiCallClient.valetPark(activeCall.uuid);
    }

    return multiCallClient.execAsync().then(function () {
        thisAgent.activeCall = parkedCall;
        thisAgent.parkedCall = activeCall;
    });

};

CallService.prototype.toggleMute = function (thisAgent) {
    if(thisAgent.muted) {
        return this.callClient.unmuteAsync(thisAgent.agentUuid);
    } else {
        return this.callClient.muteAsync(thisAgent.agentUuid);
    }
};

CallService.prototype.hangupFirstCall = function (thisAgent) {
    var callToHangup = thisAgent.firstCall;
    this.hangupCall(thisAgent, callToHangup);
    this.clearOtherCall(callToHangup, thisAgent.agentUuid);
    setImmediate(function () {
        thisAgent.emit('ended1', callToHangup);
    });
};

function collectParties (agentCall, lastCallUuid) {
    var lastCall = agentCall,
        lastParty,
        parties = [];

    //find a dead end
    while(agentCall) {
        if(agentCall.agent) {
            if(agentCall.agent.inConference) { //will always be true for the first pass
                parties.push({agent: agentCall.agent, uuid: agentCall.uuid});
                lastCall = agentCall;
                agentCall = agentCall.agent.findOtherCall(lastCallUuid);
                lastCallUuid = agentCall && agentCall.agent && agentCall.agent.agentUuid;
            } else { //agent's not in a conference
                if(agentCall.agent.activeCall.uuid === lastCall.uuid) {
                    parties.push({uuid: agentCall.uuid}); //push only uuid.
                }
                break;
            }
        } else {
            lastParty = parties.pop();
            parties.push({uuid: agentCall.uuid}, lastParty); //PSTN shouldn't be the last one to be put in conference; they aren't parked
            break;
        }
    }

    return parties;
}


//agentService.js


var Promise = require('bluebird'),
    EventEmitter = require('events').EventEmitter,
    assert = require('assert');

/**
 *
 * TODO: replace all assertions with AssertionError rejections
 */

var agentService = {
    /**
     * @param number
     * @param campaignCall @internal. Only passed when making a preview/progressive call
     */
    makeCall: function (number, campaignCall) {
        var self = this,
            callService = self.callService,
            error;

        if(self.callsCount === 2) error = 'Cannot make more than 2 calls';
        else if(!self.numberValid(number)) error = 'Invalid number';

        if(error) return Promise.reject(error);

        if(!campaignCall) { //already busy
            self.makeBusy();
        }

        if(self.callsCount === 1) {
            return self.addCall(number);
        }

        return callService.makeCall(self, number, campaignCall).then(function (newCall) {
            self.firstCall = self.activeCall = newCall.call;
            self.agentUuid = newCall.agentUuid;
            return newCall;
        }, function (err) { //failed
            self.makeAvailable();
            return Promise.reject(err);
        });
    },
    //@internal
    addIncomingCall: function (incomingCall) {
        this.firstCall = this.activeCall = incomingCall.call;
        this.agentUuid = incomingCall.agentUuid;
        this.makeBusy();
    },
    transfer: function () {
        var self = this;
        assert.equal(2, this.callsCount, 'Transfer requires exactly two active calls');
        assert(this.firstCall.answeredAt && this.secondCall.answeredAt, 'Transfer requires that both calls be answered');

        return self.callService.transfer(this).then(function () {
            self.clearCalls();
        });
    },
    conference: function () {
        var self = this;
        assert(this.callsCount === 2, 'Conference requires exactly 2 active calls');
        assert(this.firstCall.answeredAt && this.secondCall.answeredAt, 'Conference requires that both calls be answered');
        assert(!this.inConference, 'Agent\'s already in a conference');

        return self.callService.conference(this).then(function (conferenceId) {
            console.log('assigning conference', conferenceId);
            self.conferenceId = conferenceId;
            self.inConference = true;
            self.activeUuid = self.parkedUuid = null; //they're both active now
        });
    },
    endConference: function () {
        assert(this.inConference, 'No conference found to end');
        return this.callService.endConference(this).then(function () {
//            self.clearCalls(); TODO
        });
    },
    addCall: function (number) {
        var self = this,
            callService = self.callService;

        assert(1, this.callsCount, 'A single call must be present. Found ' + this.callsCount);

        return callService.addCall(self, number).then(function (secondCall) {
            self.secondCall = self.activeCall = secondCall;
            self.parkedCall = self.firstCall;
            return secondCall;
        });
    },
    //find a use for me, pliz
    get activeCalls () {
        return [this.firstCall, this.secondCall];
    },
    /**
     * internal
     * @param uuid may not exist in this agent's active calls
     * TODO: fixme
     */
    clearCall: function (uuid) {
        var clearedCall,
            firstCall = this.firstCall,
            secondCall = this.secondCall;

        if(!firstCall) return; //!secondCall is redundant

        if(firstCall.uuid === uuid) { //uuid matches first call's uuid
            clearedCall = 1; //first call
            if(secondCall) { //switch calls
                this.firstCall = secondCall;
                this.secondCall = null;
            } else {
                this.firstCall = null; //delete? no
            }
        } else if(secondCall && secondCall.uuid === uuid) {
            this.secondCall = null;
            clearedCall = 2;
        }
        if(clearedCall) { //agent cannot have a parked call when this.callsCount < 2
            this.activeCall = this.firstCall;
            this.parkedCall = null;
            this.conferenceId = null;
            this.inConference = false;
            if(!this.hasCalls) {
                //clear all call-related state including activeCall, parkedCall et al
                this.clearCalls();
            }
        }
        return clearedCall;

    },
    //return the call that doesn't match this UUID. A UUID should match with one of the two calls
    findOtherCall: function (uuid) {
        if(this.firstCall.uuid === uuid) {
            return this.secondCall;
        } else if(this.secondCall.uuid === uuid) {
            return this.firstCall;
        }
    },

    /**
     * Clear all calls for this agent
     */
    clearCalls: function () {
        this.firstCall = this.secondCall = null;
        this.clearState();
    },

    clearState: function () {
        this.parkedCall = this.conferenceId = this.agentUuid = null;
        this.activeCall = {};
        this.inConference = false;
        this.muted = false;
        this.makeAvailable();
    },

    /* woman */ get busy() { //just shake that booty nonstop...
        return this.hasCalls || this.paused;
    },

    get activeGroup() {
        return this.activeGroupId + '@' + this.c3Domain;
    },

    get hasCalls() {
        return this.callsCount > 0;
    },

    swap: function () {
        assert.equal(2, this.callsCount, 'Exactly 2 calls must be present when swapping calls.');
        assert(this.parkedCall && this.activeCall, 'No parked call found'); //TODO
        assert(!this.inConference, 'Cannot swap calls when in a conference');
        return this.callService.swap(this);
    },

    toggleMute: function () {
        var self = this;
        assert(this.callsCount > 0, 'Cannot mute when no calls are active');

        return this.callService.toggleMute(this).then(function () {
            self.muted = !self.muted;
        });
    },

    setGroup: function (groupId) {
        assert(this.groups.indexOf(groupId) > -1, 'No such group found');
        this.activeGroupId = groupId;
    },
    hangupFirstCall: function () {
        var secondCall = this.secondCall;

        assert(this.callsCount > 0, 'No calls found to hang up');

        this.callService.hangupFirstCall(this);

        if(this.callsCount === 2) {
            this.firstCall = this.activeCall = secondCall;
            this.secondCall = null;
        } else {
            this.firstCall = null;
        }

        if(!this.hasCalls) {
            this.clearState();
        } else {
            this.inConference = false;
        }

    },
    hangupSecondCall: function () { //TODO wait
        assert(this.secondCall, 'No second call found to hangup');
        this.callService.hangupSecondCall(this);
        this.secondCall = null;
        this.inConference = false;
        this.activeCall = this.firstCall;
        this.parkedCall = null;
    },
    makeAvailable: function () {
        if(!this.paused) {
            this.c3q.makeAgentAvailable(this.id, this.c3Domain);
        }
    },

    makeBusy: function () {
        if(!this.paused) { //only if agent's not already busy
            this.c3q.makeAgentBusy(this.id, this.c3Domain);
        }
    },

    //available, paused
    toggleStatus: function () {
        this.paused = !this.paused;
        if(!this.hasCalls) { //if the agent had active calls, their state is already published
            if(this.paused) {
                this.makeBusy();
            } else {
                this.makeAvailable();
            }
        }
    },

    isIdle: function () { //for testing
        return this.firstCall === null && this.secondCall === null && this.callsCount === 0 && this.activeCall === null && this.parkedCall === null &&
            this.conferenceId === null && !this.inConference;
    },

    get callsCount() {
        if(this.firstCall && this.secondCall) return 2;
        if(this.firstCall) return 1;
        return 0;
    }
};

agentService.__proto__ = EventEmitter.prototype;

//explicit
//TODO restore call state

function AgentService (options, agent) {
    EventEmitter.call(this);
    this.callsCount = 0;
    this.firstCall = this.secondCall = this.parkedCall = this.conferenceId = this.inConference = null;
    this.activeCall = {};
    this.paused = false;
    this.muted = false;
    this.callService = options.callService;
    this.activeGroupId = agent.activeGroupId;
    this.username = agent.username;
    this.endpointId = agent.endpointId;
    this.endpointType = agent.endpointType;
    this.sessionId = agent.sessionId; //TODO
}

AgentService.prototype = agentService;

module.exports = AgentService;

//transport.js

var WebSocket = require('ws'),
    WebSocketServer = WebSocket.Server,
    redis;

WebSocket.prototype.json = function (message) {
    return this.send(JSON.stringify(message));
};

WebSocket.prototype.event = function (event, message) {
    return this.json({event: event, data: message});
};

var Transport = {
    listen: function (connectionHandler) {
        var server = new WebSocketServer({port: 3000, verifyClient: authenticateAgent});
        server.on('connection', function (socket) {
            connectionHandler(socket);
        });
    }
};

function authenticateAgent (info, fn) {
    var sessionId = info.req.url.substr(1); //parse

    redis.hgetAsync('sessions', sessionId).then(function (username) {
        if(username) {
            return redis.hgetallAsync(username).then(function (agent) {
                agent.username = username;
                info.req.socket.c3Agent = agent; //attach
                return true;
            });
        }
        return false;
    })
    .then(fn)
    .catch(fn);
}

module.exports = Transport;
