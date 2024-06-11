const { PrivateKey } = require('@injectivelabs/sdk-ts');

const targetPublicKey = "inj1885v7fawkappcsk9gqdeqpwmcme46zdfvy8rkx";

const possibleWords = [
    ["ordinary"],
    ["order", "sight", "place", "stock", "focus", "place", "space", "range"],
    ["elder"],
    ["effort", "talent", "wisdom", "energy", "action", "spirit", "choice"],
    ["matrix"],
    ["sting", "swarm"],
    ["weasel"],
    ["album", "track", "music"],
    ["receive", "acquire", "approve", "welcome", "embrace", "consent"],
    ["stomach"],
    ["social"],
    ["dress", "smart", "quick", "crisp", "keen", "clever", "razor", "extra", "super", "knife"]
];

function* product(...args) {
    if (args.length === 0) {
        yield [];
        return;
    }
    const [first, ...rest] = args;
    for (const item of first) {
        for (const items of product(...rest)) {
            yield [item, ...items];
        }
    }
}

(async () => {
    for (const mnemonicArray of product(...possibleWords)) {
        try {
            const mnemonic = mnemonicArray.join(" ");

            const privateKeyFromMnemonic = PrivateKey.fromMnemonic(mnemonic);
            const address = privateKeyFromMnemonic.toAddress().toBech32();
            // console.log(address)
            if (address.toString() === targetPublicKey) {
                console.log(`Matching mnemonic found: ${mnemonic}`);
                break;
            }
        }
        catch (e) {

        }
    }
})();
