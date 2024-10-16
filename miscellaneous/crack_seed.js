const { PrivateKey } = require('@injectivelabs/sdk-ts');

const targetPublicKey = "inj1scjke0zm6920v9eewkzryak3jedk5j9yp6lfm0";

const possibleWords = [
    ["log", "leg", "lug", "lag"],
    ["bachelor"],
    ["vessel"],
    ["help", "save", "bail", "seek", "call", "warn", "plea", "yell"],
    ["point", "track", "queue"],
    ["crane", "hoist"],
    ["unique", "select", "exotic", "single", "custom"],
    ["plan", "ring", "gyro", "east", "west", "axis", "dial", "gear"],
    ["catch", "throw", "shoot", "carry", "serve"],
    ["census", "concur", "consul"],
    ["cat", "dog", "rat", "bat", "pug"],
    ["race"]
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
            console.log(address)
            if (address.toString() === targetPublicKey) {
                console.log(`Matching mnemonic found: ${mnemonic} ${address}`);
                break;
            }
        }
        catch (e) {

        }
    }
})();
