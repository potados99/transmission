(async function () {
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
