function concatenate(resultConstructor, ...arrays) {
  let totalLength = 0;
  for (const arr of arrays) {
    totalLength += arr.length;
  }
  const result = new resultConstructor(totalLength);
  let offset = 0;
  for (const arr of arrays) {
    result.set(arr, offset);
    offset += arr.length;
  }
  return result;
}

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

  forEachBuffer(fun) {
    this.iterate(fun, this.bufferStart, this.bufferEnd);
  }

  forEachWindow(fun) {
    this.iterate(fun, this.windowStart, this.windowEnd);
  }

  iterate(fun, start, end) {
    for (const [index, item] of this.buffer.slice(start, end+1).entries()) {
      let result = fun(item, this.bufferStart+index);
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

/**
 * 테스트 용도로 두 Transceiver를 이어주는 링크입니다.
 */
class Link {
  constructor(transceiver1, transceiver2) {
    this.transceiver1 = transceiver1;
    this.transceiver2 = transceiver2;

    this.init();
  }

  init() {
    const sleep = (m) => new Promise((res, rej) => setTimeout(res, m));

    this.transceiver1.uplink.onRead = (data) => Math.random() > 0.2 ? sleep(500).then(() => this.transceiver2.downlink.push(data)) : 0;
    this.transceiver2.uplink.onRead = (data) => Math.random() > 0.2 ? sleep(500).then(() => this.transceiver1.downlink.push(data)) : 0;
  }
}

/**
 * 이벤트 허브의 성격을 지니는 데이터 스트림입니다.
 * Transceiver는 하위 계층과 소통할 때에 이 스트림을 사용합니다.
 */
class Stream {
  constructor(onRead) {
    this.onRead = onRead || (() => {});
  }

  push(data) {
    this.onRead(data);
  }
}

/**
 * 프로토콜 구현체입니다.
 * full duplex로 양방향 전송 가능합니다.
 */
class Transceiver {
  constructor(name) {
    this.name = name;

    this.downlink = new Stream((data) => this._onReceiveFromDownlink(data));
    this.uplink = new Stream();

    this._windowSize = 4;

    this._sendBuffer = new WindowBuffer(this._windowSize);
    this._outbounds = [];
    this._timeoutId = 0;

    this._recvBuffer = new WindowBuffer(this._windowSize);
    this._payloadReceiveCallback = () => {};

    this.downlink = new Stream();
    this.downlink.onRead = (data) => this._onReceiveFromDownlink(data);
    this.uplink = new Stream();

    this._finishTransmission = () => {};
  }

  /**
   * 페이로드가 도착했을 때에 실행할 콜백을 등록합니다.
   * @param callback 페이로드를 인자로 하여 실행되는 콜백.
   */
  startListening(callback) {
    this._payloadReceiveCallback = callback;
  }

  /**
   * 주어진 페이로드(여러 개)의 전송을 시작합니다.
   * @param payloads 보낼 페이로드입니다. 배열 형태로 제시합니다.
   * @returns {Promise<unknown>} 전송이 모두 끝나면(=모든 페이로드가 ack를 받으면) 완료되는 Promise를 반환합니다.
   */
  startTransmission(payloads) {
    this._outbounds = payloads;

    const promise = new Promise((res) => this._finishTransmission = res);

    this._fillBuffer();
    this._sendWindowInTimeout();

    return promise;
  }

  _fillBuffer() {
    this._sendBuffer.forEachWindow((item, index) => {
      if (item == null && this._outbounds.length > 0) {
        this._sendBuffer.set(index, new OutboundDataSegment(index, this._outbounds.shift()));

        this._log(`fill buffer at seq ${index}.`);
      }
    });
  }

  _sendWindowInTimeout() {
    clearTimeout(this._timeoutId);

    const send = () => {
      this._sendWindow();
      this._timeoutId = setTimeout(() => {
        this._log(`timeout resend window`);
        send();
      },5000);
    };

    send();
  }

  _sendWindow() {
    this._sendBuffer.forEachWindow((item, index) => {
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
        this._log(`initial send ${index}`);

        this._sendToUplink(segment);
        item.sent = true;
        item.sentAt = new Date();
      } else if (itemIsSentButNoAckForLongTime) {
        this._log(`timeout send ${index}`);

        this._sendToUplink(segment);
      } else if (itemIsSentButLost) {
        this._log(`lost(dup ack) resend ${index}`);

        this._sendToUplink(segment);
        return false;
      }
    });
  }

  _sendToUplink(segment) {
    const {ack, seq, payload} = segment;

    const isAck = Number.isInteger(ack);

    const header = concatenate(
      Uint8Array,
      Uint8Array.of(ack ? 1 : 0), // 8bit flags
      new Uint8Array(Uint32Array.of(isAck ? ack : seq).buffer) // 32bit ack or seq
    );

    this.uplink.push(isAck ? header : concatenate(Uint8Array, header, payload));
  }

  _onReceiveFromDownlink(serialized) {
    const header = serialized.slice(0, 5);
    const isAck = !!(header[0] & 1);
    const ackOrSeq = new DataView(header.slice(1, 5).buffer).getUint32(0, true);
    const payload = serialized.slice(5);

    const segment = {
      ack: isAck ? ackOrSeq : undefined,
      seq: isAck ? undefined : ackOrSeq,
      payload: payload
    };

    const {ack} = segment;

    if (Number.isInteger(ack)) {
      this._handleAckSegment(segment);
    } else {
      this._handleDataSegment(segment);
    }
  }

  _handleAckSegment(segment) {
    const {ack} = segment;

    this._log(`got ack ${ack}`);

    this._sendBuffer.forEachWindow((item, index) => {
      if (item) {
        if (index < ack) {
          item.ackReceived = true;
        } else if (index === ack) {
          item.requestedFor++;
        }
      }
    });

    this._forwardSendWindowAsPossible();

    if (this._outbounds.length === 0 && this._sendBuffer.get(this._sendBuffer.windowStart) == null) {
      this._log(`all sent! finish transmission.`);

      clearTimeout(this._timeoutId);
      this._finishTransmission();
      return;
    }

    this._fillBuffer();
    this._sendWindowInTimeout();
  }

  _forwardSendWindowAsPossible() {
    while (true) {
      const window = this._sendBuffer.getWindow();
      const firstContent = window[0];
      if (firstContent != null && firstContent.ackReceived) {
        this._sendBuffer.forwardWindow();
        this._sendBuffer.collectWindowBehind();

        this._log(`window forwarded. now looks like: ${this._sendBuffer.toString()}`);
      } else {
        break;
      }
    }
  }

  _handleDataSegment(segment) {
    const {seq, payload} = segment;

    if (seq < this._recvBuffer.windowStart) {
      this._sendToUplink({ack: seq+1/*TODO send accumulative ack*/});
      this._log(`got seq ${seq} again. maybe my ack has dropped. resend ack.`);

      return;
    }

    this._recvBuffer.forEachWindow((item, index) => {
      if (index === seq) {
        this._recvBuffer.set(index, new InboundDataSegment(index, payload));
        this._log(`got seq ${seq}. saved in window.`);
      }
    });

    this._ackWindow();
    this._forwardRecvWindowAsPossible();
  }

  _ackWindow() {
    let largestContinuousSeq = this._recvBuffer.windowStart-1;

    this._recvBuffer.forEachWindow((item, index) => {
      if (item == null) {
        return;
      }

      if (index === largestContinuousSeq+1) {
        largestContinuousSeq = index;
      } else {
        this._log(`have ${index} on window but last accumulative seq ends at ${largestContinuousSeq}, so ack will be ${largestContinuousSeq+1}.`);
      }

      const segment = {ack: largestContinuousSeq+1};

      const ackNotSentYet = !item.ackSent;

      if (ackNotSentYet) {
        this._log(`sending ack ${segment.ack}`);
        this._sendToUplink(segment);
        item.ackSent = true;
      }
    })
  }

  _forwardRecvWindowAsPossible() {
    while (true) {
      const window = this._recvBuffer.getWindow();
      const firstContent = window[0];
      if (firstContent != null && firstContent.ackSent) {
        this._recvBuffer.forwardWindow();
        const received = this._recvBuffer.collectWindowBehind();

        for (const {seq, payload} of received) {
          this._payloadReceiveCallback(payload);
          this._log(`consumed ${seq}.`);
        }

        this._log(`window forwarded. now looks like: ${this._recvBuffer.toString()}`);
      } else {
        break;
      }
    }

  }

  _log(...messages) {
    if (this.name != null && this.name.trim().length > 0) {
      console.log(this.name, ...messages);
    }
  }
}

/**
 * 프로토콜 구현체의 wrapper입니다.
 */
class Socket {
  constructor(name) {
    this.transceiver = new Transceiver(name);
  }

  listen(callback) {
    this.transceiver.startListening(callback);
  }

  async send(...payloads) {
    await this.transceiver.startTransmission(payloads);
  }
}

(async function () {
  const alpha = new Socket('Alpha');
  const bravo = new Socket('Bravo');

  new Link(alpha.transceiver, bravo.transceiver);

  alpha.listen((payload) => {
    console.log(`==== alpha got [${new TextDecoder().decode(payload)}] ====`);
  });

  bravo.listen((payload) => {
    console.log(`==== bravo got [${new TextDecoder().decode(payload)}] ====`);
  });

  await Promise.all([
    alpha.send(...["hello", "world"].map(t => new TextEncoder().encode(t))),
    bravo.send(...["haha", "hoho"].map(t => new TextEncoder().encode(t)))
  ]);

  console.log('done!');
})();
