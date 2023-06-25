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
      console.warn(`nothing to collect from left side of window.`);
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

class Link {
  constructor(transceiver1, transceiver2) {
    this.transceiver1 = transceiver1;
    this.transceiver2 = transceiver2;

    this.init();
  }

  init() {
    this.transceiver1.uplink.onRead = (data) => Math.random() > 0.2 ? sleep(500).then(() => this.transceiver2.downlink.push(data)) : 0;
    this.transceiver2.uplink.onRead = (data) => Math.random() > 0.2 ? sleep(500).then(() => this.transceiver1.downlink.push(data)) : 0;
  }
}

class Stream {
  constructor() {
    this.onRead = () => {};
  }

  push(data) {
    this.onRead(data);
  }
}

class Transceiver {
  constructor(name) {
    this.name = name;

    this.windowSize = 4;

    this.sendBuffer = new WindowBuffer(this.windowSize);
    this.outbounds = [];
    this.timeoutId = 0;

    this.recvBuffer = new WindowBuffer(this.windowSize);

    this.downlink = new Stream();
    this.uplink = new Stream();

    this.init();

    this.resolve = () => {};
  }

  init() {
    this.downlink.onRead = (data) => this.onReceive(data);
  }

  async startTransmission(payloads) {
    this.outbounds = payloads;
    this.fillBuffer();

    await this.sendWindow();

    return new Promise((res) => this.resolve = res);
  }

  fillBuffer() {
    this.sendBuffer.forEachWindow((item, index) => {
      if (item == null && this.outbounds.length > 0) {
        this.sendBuffer.set(index, new OutboundDataSegment(index, this.outbounds.shift()));
        console.log(`${this.name}: fill buffer at seq ${index}.`);
      }
    });
  }

  async onReceive(segment) {
    const {ack} = segment;

    if (Number.isInteger(ack)) {
      await this.handleAckSegment(segment);
    } else {
      await this.handleDataSegment(segment);
    }
  }

  async handleAckSegment(segment) {
    const {ack} = segment;

    console.log(`${this.name}: got ack ${ack}`);

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

    await this.forwardSendWindowAsPossible();

    if (this.outbounds.length === 0 && this.sendBuffer.get(this.sendBuffer.windowStart) == null) {
      console.log(`${this.name}: all sent! finish transmission.`);
      this.resolve();
      return;
    }

    this.fillBuffer();
    await this.sendWindow();

    const send = async () => {
      await this.sendWindow();
      this.timeoutId = setTimeout(() => {
        console.log(`${this.name}: timeout resend window`);
        send();
      },5000);
    };

    await send();
  }

  async handleDataSegment(segment) {
    const {seq, payload} = segment;

    if (seq < this.recvBuffer.windowStart) {
      console.log(`${this.name}: got seq ${seq} again. maybe my ack has dropped. resend ack.`);
      await this.send({ack: seq+1/*TODO send accumulative ack*/});
      return;
    }

    await this.recvBuffer.forEachWindow((item, index) => {
      if (index === seq) {
        this.recvBuffer.set(index, new InboundDataSegment(index, payload));
        console.log(`${this.name}: got seq ${seq}. saved in window.`);
      }
    });

    await this.ackWindow();
    await this.forwardRecvWindowAsPossible();
  }

  async forwardSendWindowAsPossible() {
    while (true) {
      const window = this.sendBuffer.getWindow();
      const firstContent = window[0];
      if (firstContent != null && firstContent.ackReceived) {
        this.sendBuffer.forwardWindow();
        this.sendBuffer.collectWindowBehind();
        console.log(`${this.name}: window forwarded. now looks like: ${this.sendBuffer.toString()}`);
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
        console.log(`${this.name}: initial send ${index}`);

        await this.send(segment);
        item.sent = true;
        item.sentAt = new Date();
      } else if (itemIsSentButNoAckForLongTime) {
        console.log(`${this.name}: timeout send ${index}`);

        await this.send(segment);
      } else if (itemIsSentButLost) {
        console.log(`${this.name}: lost(dup ack) resend ${index}`);

        await this.send(segment);
        return false;
      }
    });
  }

  async forwardRecvWindowAsPossible() {
    while (true) {
      const window = this.recvBuffer.getWindow();
      const firstContent = window[0];
      if (firstContent != null && firstContent.ackSent) {
        this.recvBuffer.forwardWindow();
        const received = this.recvBuffer.collectWindowBehind();

        console.log(`${this.name}: window forwarded. now looks like: ${this.recvBuffer.toString()}`);
        console.log(`${this.name}: received ${JSON.stringify(received)}`);
      } else {
        break;
      }
    }

  }

  async ackWindow() {
    let largestContinuousSeq = this.recvBuffer.windowStart-1;

    await this.recvBuffer.forEachWindow(async (item, index) => {
      if (item == null) {
        return;
      }

      if (index === largestContinuousSeq+1) {
        largestContinuousSeq = index;
      } else {
        console.log(`${this.name}: have ${index} on window but last accumulative seq ends at ${largestContinuousSeq}, so ack will be ${largestContinuousSeq+1}.`);
      }

      const segment = {ack: largestContinuousSeq+1};

      const ackNotSentYet = !item.ackSent;

      if (ackNotSentYet) {
        console.log(`${this.name}: sending ack ${segment.ack}`);
        await this.send(segment);
        item.ackSent = true;
      }
    })
  }

  async send(segment) {
    this.uplink.push(segment);
  }
}

const alpha = new Transceiver('Alpha');
const bravo = new Transceiver('Bravo');

new Link(alpha, bravo);

alpha.startTransmission(payloads).then(() => bravo.startTransmission(['hi', 'haha']));
