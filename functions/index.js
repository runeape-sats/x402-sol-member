
const cors = require("cors")({ origin: true });

const functions = require("firebase-functions/v1");
const {
  Connection,
  PublicKey,
  Transaction: solTransaction,
} = require("@solana/web3.js");
const {
  TOKEN_PROGRAM_ID,
  decodeTransferCheckedInstruction,
} = require("@solana/spl-token");
/*───────────────────────────────────────────────────────────────────────────*/
// 🔍  Core verification & settlement helper
/*───────────────────────────────────────────────────────────────────────────*/
async function verifyAndSettle(headerValue, paymentRequirements) {
  console.log("[DEBUG] Starting verifyAndSettle");

  let decoded;
  try {
    decoded = JSON.parse(Buffer.from(headerValue, "base64").toString("utf8"));
    // console.log("[DEBUG] Decoded x-payment header:", decoded);
  } catch (err) {
    // console.error("[DEBUG] Failed to decode x-payment header", err);
    throw err;
  }

  // Extract requirements from the first accepted scheme
  const req = paymentRequirements.accepts[0];
  const PRICE = Number(req.maxAmountRequired);
  const USDC_MINT = new PublicKey(req.asset);
  const MERCHANT_TOKEN_ACCOUNT = new PublicKey(req.payTo);

  if (
    decoded.x402Version !== paymentRequirements.x402Version ||
    decoded.scheme !== req.scheme ||
    decoded.network !== req.network
  ) {
    const errorMsg = "Unsupported x402 version / scheme / network";
    console.error("[DEBUG]", errorMsg);
    throw new Error(errorMsg);
  }

  const { txBase64, reference } = decoded.payload ?? {};
  if (!txBase64) throw new Error("Missing txBase64 in payload");
  if (!reference) throw new Error("Missing reference in payload");
  // if (seenReferences.has(reference)) throw new Error("already-settled");

  // console.log("[DEBUG] Re-creating transaction from txBase64");
  const txBuffer = Buffer.from(txBase64, "base64");
  const tx = solTransaction.from(txBuffer);
  // console.log("[DEBUG] Transaction re-created:", tx);

  // Log raw instructions details
  // console.log("[DEBUG] Transaction instructions details:");
  // tx.instructions.forEach((instr, idx) => {
  //   console.log(`[DEBUG] Instruction ${idx}`, {
  //     programId: instr.programId.toBase58(),
  //     data: instr.data.toString("hex"),
  //     keys: instr.keys.map((k) => k.pubkey.toBase58()),
  //   });
  // });
  const feePayer = tx.feePayer;
  console.log("feePayer", feePayer.toBase58());

  const rpcUrl = functions.config().solana.rpcurl;
  const connection = new Connection(rpcUrl);

  const memberSpl = functions.config().solana.memberspl;

  const tokenAccounts = await connection.getParsedTokenAccountsByOwner(
    feePayer,
    {
      programId: TOKEN_PROGRAM_ID,
    },
  );
  // Find the specific token account
  const tokenAccount = tokenAccounts.value.find(
    (account) =>
      account.account.data.parsed.info.mint ===
      memberSpl,
  );
  const balance = Number(
    tokenAccount.account.data.parsed.info.tokenAmount.uiAmount,
  );
  console.log("balance", balance);
  const memberSplReq = functions.config().solana.membersplreq;
  if (balance > Number(memberSplReq)) {
    console.log(`member balance greater than ${memberSplReq}, skipping feePayer check`);
    return feePayer;
  } else {
    console.log(`non-member balance less than ${memberSplReq}, proceeding with feePayer check`);
  }

  const transferIx = tx.instructions.find(
    (ix) => ix.programId.toString() === TOKEN_PROGRAM_ID.toString(),
  );
  if (!transferIx) throw Error("No Token transferChecked in tx");

  const parsed = decodeTransferCheckedInstruction(transferIx);
  if (!parsed) throw new Error("Instruction is not transferChecked");

  const {
    data: { amount, decimals },
    keys,
  } = parsed;

  console.log("[DEBUG] Decoded transferChecked instruction:", parsed);

  const destinationPubkey = parsed["keys"]["destination"]["pubkey"];
  const mintPubkey = parsed["keys"]["mint"]["pubkey"];

  console.log("[DEBUG] Transfer details:", {
    amount,
    decimals,
    destination: destinationPubkey.toBase58(),
    mint: mintPubkey.toBase58(),
  });

  if (decimals !== 6) throw new Error("Token decimals must be 6");
  if (Number(amount) !== PRICE)
    throw new Error(`Incorrect amount – expected ${PRICE}, got ${amount}`);
  if (!destinationPubkey.equals(MERCHANT_TOKEN_ACCOUNT))
    throw new Error("Funds not going to the merchant account");
  if (!mintPubkey.equals(USDC_MINT)) throw new Error("Wrong token mint");

  const feePayerSig = tx.signatures.find(
    (sig) => feePayer && sig.publicKey.equals(feePayer),
  );
  if (!feePayerSig || !feePayerSig.signature) {
    throw new Error("Buyer (fee payer) signature missing");
  }

  console.log("[DEBUG] Fee payer signature verified");

  console.log("[DEBUG] Broadcasting transaction");

  const sig = await connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: true, // need to set it true
  });
  console.log("[DEBUG] Transaction broadcasted:", sig);
  // seenReferences.add(reference);
  // console.log("[DEBUG] Reference marked as used");

  return sig; // transaction hash
}

// x402 weather sample
exports.weather = functions.https.onRequest((req, res) => {
  cors(req, res, async () => {
    // CORS headers
    res.set("Access-Control-Allow-Origin", "*");
    res.set("Access-Control-Allow-Headers", "Content-Type, x-payment");
    if (req.method === "OPTIONS") {
      res.status(204).send("");
      return;
    }

    if (req.method !== "GET" || (req.path !== "/" && req.path !== "/weather")) {
      res.status(404).json({ error: "Not found" });
      return;
    }

    const PRICE = 10_000; // 0.01 USDC
    const USDC_MINT = new PublicKey(
      `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`, // USDC mainnet mint
    );

    const merchantTokenAcc = functions.config().solana.merchanttokenacc;
    const MERCHANT_TOKEN_ACCOUNT = new PublicKey(
      `${merchantTokenAcc}`, // example merchant token account
    );

    // todo: move to database
    const paymentRequirements = {
      x402Version: 1,
      accepts: [
        {
          scheme: "exact",
          network: `solana-mainnet-beta`,
          asset: USDC_MINT.toBase58(),
          maxAmountRequired: PRICE.toString(),
          payTo: MERCHANT_TOKEN_ACCOUNT.toBase58(),
          resource: "GET /weather",
          description: "Weather API per call (0.01 USDC)",
          maxTimeoutSeconds: 120,
        },
      ],
    };

    const payHeader = req.header("x-payment");
    // console.log("[DEBUG] Incoming payment header:", payHeader);
    if (!payHeader) {
      return res.status(402).json(paymentRequirements);
    }
    try {
      const txHash = await verifyAndSettle(payHeader, paymentRequirements);
      console.log("[DEBUG] Payment settled:", txHash);
      if (txHash) {
        const receipt = {
          txHash,
          settledAt: new Date().toISOString(),
        };
        res.set(
          "X-PAYMENT-RESPONSE",
          Buffer.from(JSON.stringify(receipt)).toString("base64"),
        );
        return res.json({ temperatureF: 72 });
      }
      return res.status(500).json({ error: "Settlement failed" });
    } catch (e) {
      return res.status(402).json({
        ...paymentRequirements,
        error: e && e.message ? e.message : String(e),
      });
    }
  });
});
