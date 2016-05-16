var express = require('express');
var app = express();
var server = require('http').Server(app);
var io = require('socket.io')(server);
var port = process.env.PORT || 8080;

app.use(express.static(__dirname + '/public'));

server.listen(port, function() {
  console.log('Server listening on port ' + port);
});

io.sockets.on('connection', function(socket) {
  // convenience function to log server messages on the client
	function log(){
		var array = [">>> Message from server: "];
	  for (var i = 0; i < arguments.length; i++) {
	  	array.push(arguments[i]);
	  }
	    socket.emit('log', array);
	}

  socket.on('message', function(message) {
    log('Got message:', message);
    socket.broadcast.emit('message', message);
  });

  socket.on('create or join', function(room) {
    var numClients = io.sockets.adapter.rooms[room] ? io.sockets.adapter.rooms[room].length : 0

    log('Room ' + room + ' has ' + numClients + ' client(s)');
    log('Request to create or join room ' + room);

    if (numClients === 0) {
      socket.join(room);
      socket.emit('created', room);
    } else if (numClients === 1) {
      io.sockets.in(room).emit('join', room);
      socket.join(room);
      socket.emit('joined', room);
    } else {
      socket.emit('full', room);
    }
    socket.emit('emit(): client ' + socket.id + ' joined room ' + room);
    socket.broadcast.emit('broadcast(): client ' + socket.id + ' joined room ' + room);
  });

  // code editor
  socket.on('new code', function(code) {
    socket.broadcast.emit('update code', code)
  });
});
