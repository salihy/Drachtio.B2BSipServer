'use strict';
const config = require('config');

const Srf = require('drachtio-srf');
const srf = new Srf();

const regMiddleware = require('drachtio-mw-registration-parser');
const parseUri = require('drachtio-sip').parser.parseUri;
const passport = require('./lib/passport');


const Rtpengine = require('rtpengine-client').Client;
const rtpengine = new Rtpengine();

const users = new Map();
const locRtp = config.get('rtpengine');


// clean up and free rtpengine resources when either side hangs up
function endCall(dlg1, dlg2, details) {
    let deleted = false;
    [dlg1, dlg2].forEach((dlg) => {
        console.log('call ended');
        dlg.on('destroy', () => {
            (dlg === dlg1 ? dlg2 : dlg1).destroy();
            if (!deleted) {
                rtpengine.delete(locRtp, details);
                deleted = true;
            }
        });
    });
}

// function returning a Promise that resolves with the SDP to offer A leg in 18x/200 answer
function getSdpA(details, remoteSdp, res) {
    return rtpengine.answer(config.get('rtpengine'), Object.assign(details, {
        'sdp': remoteSdp,
        'to-tag': res.getParsedHeader('To').params.tag,
        'ICE': 'remove'
    }))
        .then((response) => {
            if (response.result !== 'ok') throw new Error(`Error calling answer: ${response['error-reason']}`);
            return response.sdp;
        });
}


srf.connect(config.get('drachtio'))
    .on('connect', (err, hostport) => {
        if (err) {
            return console.error(`error connecting: ${err.message}`);
        }

        var trunk = config.get("trunks")[0];
        //srf.request({
        //    uri: `sip:${trunk.ip}:${trunk.port}`,
        //    method: "REGISTER",
        //    headers: {
        //        "Contact": `sip:${trunk.did}@${trunk.ip}:${trunk.port}`,
        //        "To": `"${trunk.did}"<sip:${trunk.username}@${trunk.ip}:${trunk.port}>`,
        //        "From": `"${trunk.did}"<sip:${trunk.username}@${trunk.ip}:${trunk.port}>`,
        //        "User-Agent": "viases-pbx"
        //        //"Allow": "INVITE, ACK, CANCEL, OPTIONS, BYE, REFER, NOTIFY, MESSAGE, SUBSCRIBE, INFO"
        //    },
        //    auth: {
        //        username: trunk.username,
        //        password: trunk.password
        //    }
        //}, function (err, req) {
        //    if (err) {
        //        throw err;
        //    }
        //    req.on("response", function (res) {
        //        if (res.status < 200) {
        //            console.log("Response " + res.status)
        //            return;
        //        }
        //        if (200 !== res.msg.status) {
        //            console.log("Error registering: " + res.msg.status);
        //        } else {
        //            console.log("registered successfully");
        //        }
        //    });
        //});

        console.log(`connected hostport: ${hostport}`);
    })
    .on('error', (err) => {
        console.log(`Error connecting: ${err}`);
    });


//srf.use('register', passport.authenticate('digest', { session: false }));
//srf.use('invite', passport.authenticate('digest', { session: false }));

srf.register(regMiddleware, (req, res) => {

    console.log(`got a successful registration: ${JSON.stringify(req.registration)}`);

    const hasExpires = typeof req.registration.contact[0].params.expires !== 'undefined';
    const headers = {};
    if (!hasExpires) {
        headers['Contact'] = `${req.get('Contact')};expires=${req.get('expires') || 3600}`;
    }
    else {
        headers['Contact'] = `${req.get('Contact')}`;
    }

    res.send(200, { headers });

    var parsedUri = parseUri(req.registration.aor);
     
    if (req.registration.type === 'register') {
        users.set(parsedUri.user, req.registration.contact[0].uri);
    }
    else {
        users.delete(parsedUri.user);
    }

    console.log(`there are now ${users.size} registered users after dealing with ${parsedUri.user}`);
});


srf.use('invite', (req, res, next) => {
    if (config.get('trunks').filter(w => w.ip === req.source_address).length > 0) {
        next();
    }
    //else {
    //    passport.authenticate('digest', { session: false });
    //    next();
    //}

    //viases identity authentication yapilacak.

    next();
});


srf.invite(regMiddleware, (req, res) => {

    const uri = parseUri(req.uri);

    const fromUri = parseUri(req.headers.from.replace('<', '').replace('>', ''));
    var isInbound;

    if (fromUri) {
        isInbound = config.get("trunks").filter(w => w.ip === fromUri.host)[0];
        if (!isInbound) {
            isInbound = config.get("trunks").filter(w => w.host.indexOf(fromUri.host) >= 0 )[0];
        }
    }
    var inboundRoute;

    if (isInbound) {
        inboundRoute = config.get("routes").filter(w => w.trunkid === isInbound.id)[0];
    }

    const from = req.getParsedHeader('From');
    const details = {
        'call-id': req.get('Call-Id'),
        'from-tag': from.params.tag
    };

    if (req.source_address === '157.52.146.74') {
        res.send(480, "You Shall Not Pass!");
        return;
    }

    var dest = ``;
    if (isInbound && inboundRoute) {
        dest = `sip:${inboundRoute.route}`;
        //dest = `sip:${config.get('FromAccount')}@${config.get('destination')}`

        //req.callingNumber = config.get('FromAccount');
         
        rtpengine.offer(locRtp, Object.assign(details, { 'sdp': req.body, 'record call': 'yes', 'direction': ['ext', 'int']/*, 'media address':'10.188.227.170'*/ }))
            .then((rtpResponse) => {
                console.log(`got response from rtpengine: ${JSON.stringify(rtpResponse)}`);
                if (rtpResponse && rtpResponse.result === 'ok') return rtpResponse.sdp;
                throw new Error('rtpengine failure');
            })
            .then((sdpB) => {
                console.log(`rtpengine offer returned sdp ${sdpB}`);
                return srf.createB2BUA(req, res, dest, {
                    localSdpB: sdpB,
                    localSdpA: getSdpA.bind(null, details)
                }).catch((err) => {
                    console.log(`Error connecting call: ${err.message}`);
                });
            })
            .then(({ uas, uac }) => {
                console.log('call connected with media proxy');
                return endCall(uas, uac, details);
            })
            .catch((err) => {
                console.error(`Error proxying call with media: ${err}: ${err.stack}`);
            });
    }
    else if (users.has(uri.user)) {

        if (config.get('B2BUARtp')) {
            //dest = `sip:${uri.user}@${config.get('destination')}`;
            dest = users.get(uri.user);


            rtpengine.offer(locRtp, Object.assign(details, { 'sdp': req.body, 'record call': 'yes' }))
                .then((rtpResponse) => {
                    console.log(`got response from rtpengine: ${JSON.stringify(rtpResponse)}`);
                    if (rtpResponse && rtpResponse.result === 'ok') return rtpResponse.sdp;
                    throw new Error('rtpengine failure');
                })
                .then((sdpB) => {
                    console.log(`rtpengine offer returned sdp ${sdpB}`);
                    return srf.createB2BUA(req, res, dest, {
                        localSdpB: sdpB,
                        localSdpA: getSdpA.bind(null, details)
                    });
                })
                .then(({ uas, uac }) => {
                    console.log('call connected with media proxy');
                    return endCall(uas, uac, details);
                })
                .catch((err) => {
                    console.error(`Error proxying call with media: ${err}: ${err.stack}`);
                });
        }
        else {
            dest = parseUri(req.uri).user;

            //const dest = parseUri(req.uri).user;
            if (dest && users.has(dest)) {
                const uri = `${users.get(dest)};transport=udp`;
                srf.createB2BUA(req, res, uri)
                    .then(({ uac, uas }) => {
                        console.log('connected');
                        uac.on('destroy', () => { uas.destroy(); });
                        uas.on('destroy', () => { uac.destroy(); });
                    })
                    .catch((err) => {
                        console.log(`Error connecting call: ${err.message}`);
                    });
            }
            else {
                console.log(`invite to unknown user: ${req.uri}`);
                res.send(404);
            }
        }
    }
    else {
        dest = `sip:${uri.user}@${config.get('destination')}`;
        var trunk = config.get("trunks")[0];
        //dest = `sip:${config.get('FromAccount')}@${config.get('destination')}`

        //req.callingNumber = config.get('FromAccount');

        rtpengine.offer(locRtp, Object.assign(details, { 'sdp': req.body, 'record call': 'yes' }))
            .then((rtpResponse) => {
                console.log(`got response from rtpengine: ${JSON.stringify(rtpResponse)}`);
                if (rtpResponse && rtpResponse.result === 'ok') return rtpResponse.sdp;
                throw new Error('rtpengine failure');
            })
            .then((sdpB) => {
                console.log(`rtpengine offer returned sdp ${sdpB}`);
                return srf.createB2BUA(req, res, dest, {
                    localSdpB: sdpB,
                    localSdpA: getSdpA.bind(null, details),
                    auth: {
                        username: trunk.username,
                        password: trunk.password
                    }
                })
                    .catch((err) => {
                        console.log(`Error connecting call: ${err.message}`);
                    });
            })
            .then(({ uas, uac }) => {
                console.log('call connected with media proxy');

                return endCall(uas, uac, details);
            })
            .catch((err) => {
                console.error(`Error proxying call with media: ${err}: ${err.stack}`);
            });
    }

});
