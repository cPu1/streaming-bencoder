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
		var decoded = this.decoder.decode(chunk);
		if(decoded !== false) {
			decoded.forEach(function (value) {
				this.push(value);
			}, this);
		}
		next();
	} catch (err) {
		next(err);
	}
};


module.exports = {
		transformer: function () {
			return new BencodeTransformer();
		}
};