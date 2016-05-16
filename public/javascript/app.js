$(function() {
  // Set up code editor
  var editor = ace.edit('editor');
  editor.setTheme('ace/theme/monokai');
  editor.getSession().setMode('ace/mode/javascript');

  // events for code editor
  var socket = io.connect();

  $('#editor').on('keyup', $.proxy(sendNewCode, null, editor));
  socket.on('update code', $.proxy(updateCode, null, editor));

  function sendNewCode(editor) {
    var input = editor.getValue();
    socket.emit('new code', input);
  }

  function updateCode(editor, code) {
    editor.setValue(code);
  }

  // events for WebRTC
  var isChannelReady
  var isInitiator;
  var isStarted;
  var localStream;
  var pc;
  var remoteStream;
  var turnReady;

  // configuration passed into the RTCPeerConnection object to
  // initialize the ice server configuration
  // requried to ensure most users can actualy create a connection
  // by avoiding restrictions in NAT and firewalls
  var pc_config = webrtcDetectedBrowser === 'firefox' ?
  {'iceServers':[{'url':'stun:23.21.150.121'}]} :
  {'iceServers': [{'url': 'stun:stun.l.google.com:19302'}]};

  // DtlsSrtpKeyAgreement is required for Chrome and Firefox to interoperate
  // RtpDataChannels is required if we want to make use of the
  // DataChannels API on Firefox
  var pc_constraints = {
    'optional': [
      {'DtlsSrtpKeyAgreement': true},
      {'RtpDataChannels': true}
    ]};

  // Set up audio and video regardless of what devices are present.
  var sdpConstraints = {'mandatory': {
    'OfferToReceiveAudio':true,
    'OfferToReceiveVideo':true }};

  var room = location.pathname.substring(1);
  if(room === '') {
    room = 'hello';
  }

  if (room !== "") {
    console.log('Create or join room', room);
    socket.emit('create or join', room);
  }

  socket.on('created', function(room) {
    console.log('Created room ' + room);
    isInitiator = true;
  });

  socket.on('full', function (room){
    console.log('Room ' + room + ' is full');
  });

  socket.on('join', function(room) {
    console.log('Another peer made a request to join room ' + room);
    console.log('This peer is the initiator of room ' + room + '!');
    isChannelReady = true;
  });

  socket.on('joined', function(room) {
    console.log('This peer has joined room ' + room);
    isChannelReady = true;
  });

  socket.on('log', function (array){
    console.log.apply(console, array);
  });

  // set up WebRTC
  function sendMessage(message) {
    console.log('Sending message: ', message);
    socket.emit('message', message);
  }

  socket.on('message', function (message){
    console.log('Received message:', message);
    if (message === 'got user media') {
    	maybeStart();
    } else if (message.type === 'offer') {
      if (!isInitiator && !isStarted) {
        maybeStart();
      }
      pc.setRemoteDescription(new RTCSessionDescription(message));
      doAnswer();
    } else if (message.type === 'answer' && isStarted) {
      pc.setRemoteDescription(new RTCSessionDescription(message));
    } else if (message.type === 'candidate' && isStarted) {
      var candidate = new RTCIceCandidate({sdpMLineIndex:message.label,
        candidate:message.candidate});
      pc.addIceCandidate(candidate);
    } else if (message === 'bye' && isStarted) {
      handleRemoteHangup();
    }
  });

  ////////////////////////////////////////////////////

  var localVideo = document.querySelector('#localVideo');
  var remoteVideo = document.querySelector('#remoteVideo');

  var constraints = {video: true};

  function handleUserMedia(stream) {
    localStream = stream;
    attachMediaStream(localVideo, stream);
    console.log('Adding local stream.');
    sendMessage('got user media');
    if (isInitiator) {
      maybeStart();
    }
  }

  function handleUserMediaError(error){
    console.log('getUserMedia error: ', error);
  }

  getUserMedia(constraints, handleUserMedia, handleUserMediaError);
  console.log('Getting user media with constraints', constraints);

  function maybeStart() {
    if (!isStarted && localStream && isChannelReady) {
      createPeerConnection();
      pc.addStream(localStream);
      isStarted = true;
      if (isInitiator) {
        doCall();
      }
    }
  }

  window.onbeforeunload = function(e){
  	sendMessage('bye');
  }

  /////////////////////////////////////////////////////////

  function createPeerConnection() {
    try {
      pc = new RTCPeerConnection(pc_config, pc_constraints);
      pc.onicecandidate = handleIceCandidate;
      console.log('Created RTCPeerConnnection with:\n' +
        '  config: \'' + JSON.stringify(pc_config) + '\';\n' +
        '  constraints: \'' + JSON.stringify(pc_constraints) + '\'.');
    } catch (e) {
      console.log('Failed to create PeerConnection, exception: ' + e.message);
      alert('Cannot create RTCPeerConnection object.');
      return;
    }
    pc.onaddstream = handleRemoteStreamAdded;
    pc.onremovestream = handleRemoteStreamRemoved;
  }

  // event handler when the icecandidate event is received
  // such event is fired when an RTCIceCandidate object is added to the RTCPeerConnnection
  function handleIceCandidate(event) {
    console.log('handleIceCandidate event: ', event);
    if (event.candidate) {
      sendMessage({
        type: 'candidate',
        label: event.candidate.sdpMLineIndex,
        id: event.candidate.sdpMid,
        candidate: event.candidate.candidate});
    } else {
      console.log('End of candidates.');
    }
  }

  function doCall() {
    var constraints = {'optional': [], 'mandatory': {'MozDontOfferDataChannel': true}};
    // temporary measure to remove Moz* constraints in Chrome
    if (webrtcDetectedBrowser === 'chrome') {
      for (var prop in constraints.mandatory) {
        if (prop.indexOf('Moz') !== -1) {
          delete constraints.mandatory[prop];
        }
       }
     }
    constraints = mergeConstraints(constraints, sdpConstraints);
    console.log('Sending offer to peer, with constraints: \n' +
      '  \'' + JSON.stringify(constraints) + '\'.');
    pc.createOffer(setLocalAndSendMessage, failureCallback, constraints);
  }

  function doAnswer() {
    console.log('Sending answer to peer.');
    pc.createAnswer(setLocalAndSendMessage, failureCallback, sdpConstraints);
  }

  function failureCallback() {
    console.log("Failed to create.");
  }

  function mergeConstraints(cons1, cons2) {
    var merged = cons1;
    for (var name in cons2.mandatory) {
      merged.mandatory[name] = cons2.mandatory[name];
    }
    merged.optional.concat(cons2.optional);
    return merged;
  }

  function setLocalAndSendMessage(sessionDescription) {
    // Set Opus as the preferred codec in SDP if Opus is present.
    sessionDescription.sdp = preferOpus(sessionDescription.sdp);
    pc.setLocalDescription(sessionDescription);
    sendMessage(sessionDescription);
  }

  function requestTurn(turn_url) {
    var turnExists = false;
    for (var i in pc_config.iceServers) {
      if (pc_config.iceServers[i].url.substr(0, 5) === 'turn:') {
        turnExists = true;
        turnReady = true;
        break;
      }
    }
    if (!turnExists) {
      console.log('Getting TURN server from ', turn_url);
      // No TURN server. Get one from computeengineondemand.appspot.com:
      var xhr = new XMLHttpRequest();
      xhr.onreadystatechange = function(){
        if (xhr.readyState === 4 && xhr.status === 200) {
          var turnServer = JSON.parse(xhr.responseText);
        	console.log('Got TURN server: ', turnServer);
          pc_config.iceServers.push({
            'url': 'turn:' + turnServer.username + '@' + turnServer.turn,
            'credential': turnServer.password
          });
          turnReady = true;
        }
      };
      xhr.open('GET', turn_url, true);
      xhr.send();
    }
  }

  function handleRemoteStreamAdded(event) {
    console.log('Remote stream added.');
   // reattachMediaStream(miniVideo, localVideo);
    attachMediaStream(remoteVideo, event.stream);
    remoteStream = event.stream;
  }

  function handleRemoteStreamRemoved(event) {
    console.log('Remote stream removed. Event: ', event);
  }

  function hangup() {
    console.log('Hanging up.');
    stop();
    sendMessage('bye');
  }

  function handleRemoteHangup() {
    console.log('Session terminated.');
    stop();
    isInitiator = false;
  }

  function stop() {
    isStarted = false;
    // isAudioMuted = false;
    // isVideoMuted = false;
    pc.close();
    pc = null;
  }

  ///////////////////////////////////////////

  // Set Opus as the default audio codec if it's present.
  function preferOpus(sdp) {
    var sdpLines = sdp.split('\r\n');
    var mLineIndex;
    // Search for m line.
    for (var i = 0; i < sdpLines.length; i++) {
        if (sdpLines[i].search('m=audio') !== -1) {
          mLineIndex = i;
          break;
        }
    }
    if (mLineIndex === null) {
      return sdp;
    }

    // If Opus is available, set it as the default in m line.
    for (i = 0; i < sdpLines.length; i++) {
      if (sdpLines[i].search('opus/48000') !== -1) {
        var opusPayload = extractSdp(sdpLines[i], /:(\d+) opus\/48000/i);
        if (opusPayload) {
          sdpLines[mLineIndex] = setDefaultCodec(sdpLines[mLineIndex], opusPayload);
        }
        break;
      }
    }

    // Remove CN in m line and sdp.
    sdpLines = removeCN(sdpLines, mLineIndex);

    sdp = sdpLines.join('\r\n');
    return sdp;
  }

  function extractSdp(sdpLine, pattern) {
    var result = sdpLine.match(pattern);
    return result && result.length === 2 ? result[1] : null;
  }

  // Set the selected codec to the first in m line.
  function setDefaultCodec(mLine, payload) {
    var elements = mLine.split(' ');
    var newLine = [];
    var index = 0;
    for (var i = 0; i < elements.length; i++) {
      if (index === 3) { // Format of media starts from the fourth.
        newLine[index++] = payload; // Put target payload to the first.
      }
      if (elements[i] !== payload) {
        newLine[index++] = elements[i];
      }
    }
    return newLine.join(' ');
  }

  // Strip CN from sdp before CN constraints is ready.
  function removeCN(sdpLines, mLineIndex) {
    var mLineElements = sdpLines[mLineIndex].split(' ');
    // Scan from end for the convenience of removing an item.
    for (var i = sdpLines.length-1; i >= 0; i--) {
      var payload = extractSdp(sdpLines[i], /a=rtpmap:(\d+) CN\/\d+/i);
      if (payload) {
        var cnPos = mLineElements.indexOf(payload);
        if (cnPos !== -1) {
          // Remove CN payload from m line.
          mLineElements.splice(cnPos, 1);
        }
        // Remove CN line in sdp
        sdpLines.splice(i, 1);
      }
    }

    sdpLines[mLineIndex] = mLineElements.join(' ');
    return sdpLines;
  }

});
