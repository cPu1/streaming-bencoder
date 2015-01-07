'use strict'

const INTEGER_START = 'i'.charCodeAt(),
	STRING_DELIM = ':'.charCodeAt(),
	DICTIONARY_START = 'd'.charCodeAt(),
	LIST_START = 'l'.charCodeAt(),
	END_OF_TYPE = 'e'.charCodeAt();

var decoderProto = {
		reset: function () {
			this.position = 0;
			this.input = null;
		},
		position: 0,
		decode: function (buffer) {
			let buffers = this.input? [this.input, buffer] : [buffer];
			this.input = Buffer.concat(buffers);
			if(!this.generator) {
				this.generator = this.parse();
			}
			return this._decode();
		},
		_decode: function () {
			let decodedValues = [];
			while(true) {
				let decoded = this.generator.next();
				if(decoded.done) {
					decodedValues.push(decoded.value);
					this.input = this.input.slice(this.position);
					this.position = 0;
					this.generator = this.parse();
					if(!this.input.length) break;
				} else {
					break;
				}
			}
			return decodedValues.length ? decodedValues : false;
		},
		parse: function *(hint) { //hint about the type: for parseString
			while(true) {
				let type = hint || this.input[this.position];
				switch(type) {
				case DICTIONARY_START:
					return yield *this.parseDictionary();
				case LIST_START:
					return yield *this.parseList();
				case INTEGER_START:
					return yield *this.parseInteger();
				case undefined:
					yield false;
					break;
				case END_OF_TYPE:
					return null;
				default:
					if(type > 47 && type < 58) {
						return yield *this.parseString();
					}
					this.throwError('Invalid bencode type', type, this.position);
				}
			}
		},
		parseString: function *() { // parse a string value as buffer
			let value,
				offset = this.position,
				strLength = '',
				length;
			
			while(value === undefined) {
				while(length === undefined) {
					let chr;
					
					while(this.position < this.input.length && (chr = this.input[this.position ++]) !== STRING_DELIM) {
						if(chr < 48 || chr > 57) this.throwError('Invalid string length', chr, this.position - 1);
					}
					
					if(chr === STRING_DELIM) {
						length = + this.input.slice(offset, this.position - 1).toString(); // no :
					} else {
						yield false;
					}
				}
				while(this.input.length < this.position + length) {
					yield false;
				}
				
				value = this.input.slice(this.position, this.position + length);
				this.position += length;
				return value.toString('binary');
			}
		},
		parseInteger: function *() {
			let intValue;
			
			this.position ++;
			
			let offset = this.position;
			while(intValue === undefined) {
				let chr;
				while(this.position < this.input.length && (chr = this.input[this.position ++]) !== END_OF_TYPE) {
					if(chr < 48 || chr > 57) this.throwError('Invalid integer value', chr, this.position - 1);
				}
				if(chr === END_OF_TYPE) {
					intValue = + this.input.slice(offset, this.position - 1).toString();
				} else {
					yield false;
				}
			}
			return intValue;
		},
		
		parseDictionary: function *() {
			let dict = {};
			this.position ++; //advance
			
			while(this.input.length <= this.position) {
				yield false;
			}
			
			while(this.input[this.position] !== END_OF_TYPE) {
				//hint string
				let key = yield *this.parse(50); //cannot use parseString here. At this point we're already within parseString and an END_OF_TYPE input will result in an error
				if(key == null) break;
				let value = yield *this.parse();
				if(value !== null) {
					dict[key.toString()] = value;
				}
			}
			this.position ++;
			return dict;
		},
		parseList: function *() {
			let list = [];
			
			this.position ++; //advance over l
			
			while(this.input.length <= this.position) {
				yield false;
			}
			
			while(this.input[this.position] !== END_OF_TYPE) {
				let value = yield *this.parse();
				if(value !== null) { //END_OF_TYPE?
					list.push(value);
				}
				
			}
			this.position ++;
			return list;
		},
		throwError: function (error, char, position) {
			throw new Error(error + " '" + String.fromCharCode(char) + "' at position " + position);
		}
}

var encoder = {
		encodeString: function (s) {
			return s.length + ':' + s;
		},
		encodeBuffer: function (b) {
			return this.encodeString(b.toString('binary'));
		},
		encodeInteger: function (i) {
			return 'i' + i + 'e';
		},
		encodeDictionary: function (o) {
			var value = 'd';
			for(var i in o) {
				value += this.encodeString(i) + this.encode(o[i]);
			}
			value += 'e';
			return value;
		},
		encodeList: function (array) {
			var self = this;
			var encoded = array.reduce(function (value, el) {
				return value + self.encode(el);
			}, '');
			return 'l' + encoded + 'e';
		},
		encode: function (value) {
			var type = typeof value;
			switch(type) {
				case 'string':
					return this.encodeString(value);
				break;
				case 'number':
					return this.encodeInteger(value);
				break;
				case 'undefined':
					return 'undefined';
				break;
				default:
					if(value === null) {
						return 'null';
					} else if(Array.isArray(value)) {
						return this.encodeList(value);
					} else if(Buffer.isBuffer(value)) {
						return this.encodeBuffer(value);
					} else if(type == 'object') {
						return this.encodeDictionary(value);
					}
					
			}
		}
};

module.exports = {
		decoder: function () {
			var decoder = Object.create(decoderProto);
			decoder.position = 0;
			return decoder;
		},
		encoder: encoder //state-less
};