class RingBuffer {
  constructor(length) {
    this.buffer = Array.from(Array(length).keys()).map((i) => ({seq: i}));
    this.firstSeq = 0;
    this.lastSeq = length-1;
  }

  shift() {
    this.firstSeq++;
    this.buffer.push({seq: ++this.lastSeq});
    return this.buffer.shift();
  }

  set(seq, content) {
    this.buffer.find(item => item.seq === seq).content = content;
  }

  get(seq) {
    return this.buffer.find(item => item.seq === seq).content;
  }

  slice(start, end) {
    return this.buffer.slice(start-this.firstSeq, end-this.firstSeq);
  }

  linear() {
    return this.buffer.sort((item) => item.seq);
  }
}

class WindowBuffer {
  constructor(windowSize) {
    this.buffer = new RingBuffer(windowSize * 4);
    this.windowStart = 0;
    this.windowEnd = windowSize-1;
  }

  forwardWindow() {
    if (this.windowEnd >= this.buffer.lastSeq) {
      throw new Error('Cannot forward window further.');
    }

    this.windowStart++;
    this.windowEnd++;
  }

  getWindow() {
    return this.buffer.slice(this.windowStart, this.windowEnd+1);
  }

  fill(contents) {
    for (let i = 0; i < contents.length; i++) {
      this.buffer.set(this.buffer.firstSeq+i, contents[i]);
    }
  }

  collectWindowBehind() {
    const collected = [];

    if (this.buffer.firstSeq >= this.windowStart) {
      console.warn('nothing to collect from left side of window.');
      return [];
    }

    while (this.buffer.firstSeq < this.windowStart) {
      collected.push(this.buffer.shift());
    }

    return collected;
  }

  get(seq) {
    return this.buffer.get(seq);
  }

  set(seq, content) {
    this.buffer.set(seq, content);
  }

  toString() {
    let line = '';
    for (const item of this.buffer.linear()) {
      line += ` ${item.seq === this.windowStart ? '[' : ''}${item.seq}${item.content?.payload ? '(' + item.content?.payload + ')' : ''}${item.seq === this.windowEnd ? ']' : ''} `;
    }
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
    for (const holder of this.sendBuffer.getWindow()) {
      if (holder.content == null && this.payloadsLeft.length > 0) {
        holder.content = {
          sent: false,
          acked: false,
          requests: 0,
          payload: this.payloadsLeft.shift()
        };
      }
    }
  }

  async onReceive(packet) {
    const {ack} = packet;

    for (const {seq, content} of this.sendBuffer.getWindow()) {
      if (content) {
        if (seq < ack) {
          content.acked = true;
        } else if (seq === ack) {
          content.requests++;
        }
      }
    }

    clearTimeout(this.timeoutId);

    await this.forwardWindowAsPossible();
    this.fillBuffer();
    await this.sendWindow();

    const send = async () => {
      await this.sendWindow();
      this.timeoutId = setTimeout(() => send(),5000);
    };

    await send();
  }

  async forwardWindowAsPossible() {
    while (true) {
      const window = this.sendBuffer.getWindow();
      const firstContent = window[0].content;
      if (firstContent != null && firstContent.acked) {
        this.sendBuffer.forwardWindow();
        this.sendBuffer.collectWindowBehind();
        console.log(this.sendBuffer.toString());
      } else {
        break;
      }
    }
  }

  async sendWindow() {
    for (const {seq, content} of this.sendBuffer.getWindow()) {
      if (content == null) {
        return;
      }

      const packet = {seq, payload: content.payload}

      if (!content.sent) {
        await this.send(packet);
        content.sent = true;
      } else if (content.sent && !content.acked && content.requests > 1) {
        await this.send(packet);
        break;
      }
    }
  }

  async send(packet) {

    if (Math.random() > 0.8) {
      console.warn('lost data!');
      return;
    }

    if (this.lastSeq == null) {
      this.lastSeq = -1;
    }

    if (packet.seq === this.lastSeq+1) {
      this.lastSeq = packet.seq;
    }

    console.log(packet);

    if (Math.random() > 0.8) {
      console.warn('lost ack!');
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


new Transmitter().startTransmission(payloads);






console.log('hi')

