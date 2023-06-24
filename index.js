/**
 * 나가는 데이터 세그먼트입니다.
 * 페이로드와 상태를 함께 포함합니다.
 */
class OutboundDataSegment {
  constructor(seq, payload) {
    this.seq = seq;
    this.payload = payload;
    this.sent = false;
    this.sentAt = null;
    this.ackReceived = false;
    this.requestedFor = 0;
  }
}

/**
 * 들어오는 데이터 세그먼트입니다.
 * 페이로드와 상태를 함께 포함합니다.
 */
class InboundDataSegment {
  constructor(seq, payload) {
    this.seq = seq;
    this.payload = payload;
    this.ackSent = false;
  }
}

/**
 * 슬라이딩 윈도우를 가지는 버퍼입니다.
 */
class WindowBuffer {
  constructor(windowSize) {
    this.buffer = Array(windowSize*4);

    this.bufferStart = 0;
    this.bufferEnd = this.buffer.length-1;

    this.windowStart = 0;
    this.windowEnd = windowSize-1;
  }

  get(index) {
    return this.buffer[index];
  }

  set(index, value) {
    this.buffer[index] = value;
  }

  shift() {
    this.buffer.push(undefined);
    this.bufferEnd++;
    return this.buffer[this.bufferStart++];
  }

  forwardWindow() {
    if (this.windowEnd >= this.bufferEnd) {
      throw new Error('Cannot forward window further.');
    }

    this.windowStart++;
    this.windowEnd++;
  }

  getWindow() {
    return this.buffer.slice(this.windowStart, this.windowEnd+1);
  }

  async forEachBuffer(fun) {
    await this.iterate(fun, this.bufferStart, this.bufferEnd);
  }

  async forEachWindow(fun) {
    await this.iterate(fun, this.windowStart, this.windowEnd);
  }

  async iterate(fun, start, end) {
    for (const [index, item] of this.buffer.slice(start, end+1).entries()) {
      let result = fun(item, this.bufferStart+index);
      if (result instanceof Promise) {
        result = await result;
      }

      if (result === false) {
        break;
      }
    }
  }

  collectWindowBehind() {
    const collected = [];

    if (this.windowStart === this.bufferStart) {
      console.warn('sender: nothing to collect from left side of window.');
      return [];
    }

    while (this.bufferStart < this.windowStart) {
      collected.push(this.shift());
    }

    return collected;
  }

  toString() {
    let line = '';

    this.forEachBuffer((item, index) => {
      line += ` ${index === this.windowStart ? '[' : ''}${index}${item?.payload ? '(' + item?.payload + ')' : ''}${index === this.windowEnd ? ']' : ''} `;
    });

    return line;
  }
}

const sleep = (m) => new Promise((res, rej) => setTimeout(res, m));

const payloads = [
  'hello', 'world', 'haha', 'yeah', 'hoho', 'huhu', 'hello', 'world', 'haha', 'yeah', 'hoho', 'huhu', 'hello', 'world', 'haha', 'yeah', 'hoho', 'huhu'
];

class Transmitter {
  constructor() {
    this.windowSize = 4;
    this.sendBuffer = new WindowBuffer(this.windowSize);
    this.payloadsLeft = [];
    this.timeoutId = 0;
  }

  async startTransmission(payloads) {
    this.payloadsLeft = payloads;
    this.fillBuffer();

    await this.sendWindow();
  }

  fillBuffer() {
    this.sendBuffer.forEachWindow((item, index) => {
      if (item == null && this.payloadsLeft.length > 0) {
        this.sendBuffer.set(index, new OutboundDataSegment(index, this.payloadsLeft.shift()));
      }
    });
  }

  async onReceive(packet) {
    const {ack} = packet;

    await this.sendBuffer.forEachWindow((item, index) => {
      if (item) {
        if (index < ack) {
          item.ackReceived = true;
        } else if (index === ack) {
          item.requestedFor++;
        }
      }
    });

    clearTimeout(this.timeoutId);

    await this.forwardWindowAsPossible();
    this.fillBuffer();
    await this.sendWindow();

    const send = async () => {
      await this.sendWindow();
      this.timeoutId = setTimeout(() => {
        console.log(`sender: timeout resend window!`);
        send();
      },5000);
    };

    await send();
  }

  async forwardWindowAsPossible() {
    while (true) {
      const window = this.sendBuffer.getWindow();
      const firstContent = window[0];
      if (firstContent != null && firstContent.ackReceived) {
        this.sendBuffer.forwardWindow();
        this.sendBuffer.collectWindowBehind();
        console.log(`sender: window forwarded ${this.sendBuffer.toString()}`);
      } else {
        break;
      }
    }
  }



  async sendWindow() {
    await this.sendBuffer.forEachWindow(async (item, index) => {
      if (item == null) {
        return false;
      }

      const segment = {
        seq: index,
        payload: item.payload
      };

      const itemIsNotSentYet = !item.sent;
      const itemIsSentButNoAckForLongTime = item.sent && !item.ackReceived && (new Date() - item.sentAt) > 5000;
      const itemIsSentButLost = item.sent && !item.ackReceived && item.requestedFor > 1;

      if (itemIsNotSentYet) {
        await this.send(segment);
        item.sent = true;
        item.sentAt = new Date();
      } else if (itemIsSentButNoAckForLongTime) {
        await this.send(segment);
      } else if (itemIsSentButLost) {
        await this.send(segment);
        return false;
      }
    });
  }

  async send(segment) {

    console.log(`sender: send ${segment.seq}`);

    if (Math.random() > 0.8) {
      console.warn('network: lost data!');
      return;
    }

    if (this.lastSeq == null) {
      this.lastSeq = -1;
    }

    if (segment.seq === this.lastSeq+1) {
      this.lastSeq = segment.seq;
    }

    console.log(`receiver: got ${segment.seq}. give me ${this.lastSeq+1}.`);

    if (Math.random() > 0.8) {
      console.warn('network: lost ack!');
      return;
    }

    sleep(500).then(() => this.onReceive({ack: this.lastSeq+1}))



  }
}

class Transceiver {
  constructor() {
    this.sendBuffer
  }



}

//console.log(new WindowBuffer(4).toString());

new Transmitter().startTransmission(payloads);






console.log('hi')

