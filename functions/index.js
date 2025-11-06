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
// 🔍  Core verification & settlement helpers
/*───────────────────────────────────────────────────────────────────────────*/

/**
 * Decodes the base64-encoded x-payment header into a JSON object.
 * @param {string} headerValue - The base64-encoded header value.
 * @returns {object} The decoded JSON object.
 * @throws {Error} If decoding or parsing fails.
 */
const decodePaymentHeader = (headerValue) => {
  try {
    return JSON.parse(Buffer.from(headerValue, "base64").toString("utf8"));
  } catch (err) {
    throw new Error("Failed to decode x-payment header");
  }
};

/**
 * Validates the decoded payment header against the payment requirements.
 * @param {object} decoded - The decoded header object.
 * @param {object} paymentRequirements - The expected payment requirements.
 * @returns {object} The first accepted scheme requirement.
 * @throws {Error} If version, scheme, or network doesn't match.
 */
const validatePaymentRequirements = (decoded, paymentRequirements) => {
  const req = paymentRequirements.accepts[0];
  if (
    decoded.x402Version !== paymentRequirements.x402Version ||
    decoded.scheme !== req.scheme ||
    decoded.network !== req.network
  ) {
    throw new Error("Unsupported x402 version / scheme / network");
  }
  return req;
};

/**
 * Checks if the fee payer is a member based on SPL token balance.
 * @param {Connection} connection - Solana connection instance.
 * @param {PublicKey} feePayer - The public key of the fee payer.
 * @returns {boolean} True if the balance exceeds the required amount.
 */
const checkMembership = async (connection, feePayer) => {
  const memberSpl = functions.config().solana.memberspl;
  const tokenAccounts = await connection.getParsedTokenAccountsByOwner(
    feePayer,
    { programId: TOKEN_PROGRAM_ID },
  );
  const tokenAccount = tokenAccounts.value.find(
    (account) => account.account.data.parsed.info.mint === memberSpl,
  );
  if (!tokenAccount) return false;
  const balance = Number(
    tokenAccount.account.data.parsed.info.tokenAmount.uiAmount,
  );
  const memberSplReq = Number(functions.config().solana.membersplreq);
  return balance > memberSplReq;
};

/**
 * Verifies the Solana transaction details against the payment requirements.
 * @param {Transaction} tx - The Solana transaction object.
 * @param {object} req - The payment requirement object.
 * @returns {PublicKey} The fee payer's public key.
 * @throws {Error} If transaction details don't match requirements.
 */
const verifyTransaction = (tx, req) => {
  const PRICE = Number(req.maxAmountRequired);
  const USDC_MINT = new PublicKey(req.asset);
  const MERCHANT_TOKEN_ACCOUNT = new PublicKey(req.payTo);

  const transferIx = tx.instructions.find(
    (ix) => ix.programId.toString() === TOKEN_PROGRAM_ID.toString(),
  );
  if (!transferIx) throw new Error("No Token transferChecked in tx");

  const parsed = decodeTransferCheckedInstruction(transferIx);
  if (!parsed) throw new Error("Instruction is not transferChecked");

  const {
    data: { amount, decimals },
    keys,
  } = parsed;
  const destinationPubkey = keys.destination.pubkey;
  const mintPubkey = keys.mint.pubkey;

  if (decimals !== 6) throw new Error("Token decimals must be 6");
  if (Number(amount) !== PRICE)
    throw new Error(`Incorrect amount – expected ${PRICE}, got ${amount}`);
  if (!destinationPubkey.equals(MERCHANT_TOKEN_ACCOUNT))
    throw new Error("Funds not going to the merchant account");
  if (!mintPubkey.equals(USDC_MINT)) throw new Error("Wrong token mint");

  const feePayer = tx.feePayer;
  const feePayerSig = tx.signatures.find(
    (sig) => feePayer && sig.publicKey.equals(feePayer),
  );
  if (!feePayerSig || !feePayerSig.signature) {
    throw new Error("Buyer (fee payer) signature missing");
  }

  return feePayer;
};

/**
 * Broadcasts the signed transaction to the Solana network.
 * @param {Connection} connection - Solana connection instance.
 * @param {Transaction} tx - The signed transaction.
 * @returns {string} The transaction signature.
 */
const broadcastTransaction = async (connection, tx) => {
  return await connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: true,
  });
};

/**
 * Main function to verify and settle an x402 payment.
 * @param {string} headerValue - The x-payment header value.
 * @param {object} paymentRequirements - The payment requirements object.
 * @returns {string} The transaction signature if successful.
 * @throws {Error} If verification or settlement fails.
 */
async function verifyAndSettle(headerValue, paymentRequirements) {
  console.log("[DEBUG] Starting verifyAndSettle");

  const decoded = decodePaymentHeader(headerValue);
  const req = validatePaymentRequirements(decoded, paymentRequirements);

  const { txBase64, reference } = decoded.payload ?? {};
  if (!txBase64) throw new Error("Missing txBase64 in payload");
  if (!reference) throw new Error("Missing reference in payload");

  const txBuffer = Buffer.from(txBase64, "base64");
  const tx = solTransaction.from(txBuffer);

  const feePayer = tx.feePayer;
  console.log("feePayer", feePayer.toBase58());

  const rpcUrl = functions.config().solana.rpcurl;
  const connection = new Connection(rpcUrl);

  const isMember = await checkMembership(connection, feePayer);
  if (isMember) {
    console.log(`member balance greater than req, skipping feePayer check`);
    return feePayer;
  } else {
    console.log(
      `non-member balance less than req, proceeding with feePayer check`,
    );
  }

  verifyTransaction(tx, req);

  console.log("[DEBUG] Broadcasting transaction");
  const sig = await broadcastTransaction(connection, tx);
  console.log("[DEBUG] Transaction broadcasted:", sig);

  return sig;
}

// x402 weather sample
/**
 * Firebase Cloud Function for the /weather endpoint.
 * Handles x402 payment verification and returns weather data if payment is valid.
 * Supports membership discounts based on SPL token balance.
 */
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
