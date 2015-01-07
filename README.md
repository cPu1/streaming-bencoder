streaming-bencoder
==================
A streaming bencode decoder for Node.js written using ECMAScript 6 generators. Can parse any bencoded value in a stream of bencoded values.


Examples:
```javascript
var bencoder = require('streaming-bencoder'),
  ReadableStream = require('stream').Readable;
  
var source = new Readable();

source._read = function () {};

source.push('d5:elistle6:elist2l0:0:0:0:1:12:22e0:0:6:string11:Hello World7:integeri12345e10:dictionaryd3:key36:This is a string within a dictionarye4:listli1ei2ei3ei4e6:stringi5edeee');

source.pipe(bencoder.transformer()).on('data', console.log);

{ elist: [],
  elist2: [ '', '', '', '', '1', '22' ],
  '': '',
  string: 'Hello World',
  integer: 12345,
  dictionary: { key: 'This is a string within a dictionary' },
  list: [ 1, 2, 3, 4, 'string', 5, {} ] }
  
  
