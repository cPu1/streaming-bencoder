var Transform = require('stream').Transform,
	bencode = require('./bencoder');

function BencodeTransformer () {
	Transform.call(this);
	this.decoder = bencode.decoder();
	this._readableState.objectMode = true;
}

BencodeTransformer.prototype = Object.create(Transform.prototype, {constructor: BencodeTransformer});

BencodeTransformer.prototype._transform = function (chunk, encoding, next) {
	try {
//		while((this.decoded = this.decoder.decode(chunk).value !== false)) {
//			this.push(this.decoded);
//		}
		var decoded = this.decoder.decode(chunk);
		if(decoded === false) {
			console.log('Waiting for input');
		} else {
			decoded.forEach(function (value) {
				this.push(value);
			}, this);
		}
		next();
	} catch (err) {
		console.log('Errrrr', err.stack)
		next(err);
//		this.decoder = bencode.decoder(); //reset
	}
};


var bt = new BencodeTransformer();

process.stdin.setRawMode(true);

process.stdin.pipe(bt).on('data', function (data) {
	console.error('Stream decoded', data);
}).on('error', console.log);

//
//require('net').createServer(function (socket) {
//	socket.pipe(bt).on('data', function (d) {
//		console.log('Server received ', d);
//	});
//}).listen(3000);
//
//var crypto = require('crypto');
//
//var fs = require('fs');
//
//fs.createReadStream('./tt.torrent').pipe(bt).on('data', function (data) {
//	var info = data.info;
////	return console.log(data[0]['announce-list']);
//	console.log(Buffer.byteLength(info));
//	var encoded = bencode.encoder.encode(info);
//	console.log(encodeURIComponent(crypto.createHash('sha1').update(encoded).digest('binary')));
//	encoded = crypto.createHash('sha1').update(encoded).digest('hex');
//	console.log('Encoded', encoded);
//});


//
//
//fs.readFile('./test.torrent', function (err, data) {
//	var a = data.slice(593, data.length - 1);
//	console.log(a.toString(), a[0], a[1], a.length);
//	fs.createWriteStream('./tor2').write(a);
//	var hash = crypto.createHash('sha1').update(a).digest('hex');
//	console.log(hash);
//});
