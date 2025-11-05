import { useState } from "react";

import {
  TransactionInstruction,  PublicKey, Transaction, Connection
} from "@solana/web3.js";
import { ComputeBudgetProgram } from "@solana/web3.js";
import {
  getAssociatedTokenAddress,
  createTransferCheckedInstruction,
} from "@solana/spl-token";

const Wallet = () => {
  const [provider, setProvider] = useState(null);
  const [connection, setConnection] = useState(null);
  const [output, setOutput] = useState("");
  const [isLoading, setIsLoading] = useState(false);

  // Configuration from environment variables (Vite uses import.meta.env)
  const RPC = import.meta.env.VITE_RPC_ENDPOINT || "https://api.mainnet-beta.solana.com";
  const USDC_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
  const MERCHANT_TOKEN_ACCOUNT = import.meta.env.VITE_MERCHANT_TOKEN_ACCOUNT ? new PublicKey(import.meta.env.VITE_MERCHANT_TOKEN_ACCOUNT) : null;
  const PRICE = 10000; // 0.01 USDC

  // Connect to Phantom wallet
  const connectPhantom = async () => {
    setIsLoading(true);
    const provider = window.solana;
    if (!provider?.isPhantom) {
      alert("Please install Phantom wallet");
      setIsLoading(false);
      return;
    }
    try {
      await provider.connect();
      const connection = new Connection(RPC, "confirmed");
      setProvider(provider);
      setConnection(connection);
      setOutput(`Connected ${provider.publicKey.toBase58()}`);
    } catch (error) {
      setOutput(`Connection failed: ${error.message}`);
    } finally {
      setIsLoading(false);
    }
  };

  // Pay and fetch weather data
  const payAndFetch = async () => {
    if (!provider || !connection) {
      alert("Please connect wallet first");
      return;
    }

    setIsLoading(true);
    try {
      // Get buyer's associated token account
      const buyerATA = await getAssociatedTokenAddress(
        USDC_MINT,
        provider.publicKey,
      );

      // Create transaction
      const { blockhash } = await connection.getLatestBlockhash();
      const tx = new Transaction({
        recentBlockhash: blockhash,
        feePayer: provider.publicKey,
      });

      // Add USDC transfer instruction
      tx.add(
        createTransferCheckedInstruction(
          buyerATA,
          USDC_MINT,
          MERCHANT_TOKEN_ACCOUNT,
          provider.publicKey,
          PRICE,
          6, // USDC decimals:6
        ),
      );

      // Add memo instruction
      const ref = crypto.randomUUID();
      tx.add(
        new TransactionInstruction({
          keys: [],
          programId: new PublicKey(
            "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr",
          ),
          data: new TextEncoder().encode(`x402:${ref}`),
        }),
      );

      tx.add(
        ComputeBudgetProgram.setComputeUnitLimit({ units: 130_000 }), // plenty for transfer
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 0 }), // zero tip
      );

      // Sign and serialize transaction
      const signed = await provider.signTransaction(tx);
      const txBase64 = btoa(String.fromCharCode(...signed.serialize()));

      // Create x402 payment header
      const xPayment = btoa(
        JSON.stringify({
          x402Version: 1,
          scheme: "exact",
          network: `solana-mainnet-beta`,
          payload: { txBase64, reference: ref },
        }),
      );

      console.log("xPayment header:", xPayment);

      // Call /weather API
      const response = await fetch(
        import.meta.env.VITE_FIREBASE_FUNCTIONS_URL || "http://127.0.0.1:5001/weather",
        {
          method: "GET",
          headers: { "X-PAYMENT": xPayment },
        },
      );

      if (!response.ok) {
        throw new Error(`API error: ${response.status} ${response.statusText}`);
      }

      const data = await response.json();
      setOutput(JSON.stringify(data, null, 2));
    } catch (error) {
      setOutput(`Error: ${error.message}`);
      console.error(error);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div>
      <h1>Pay-per-call Weather {PRICE / 1000000} USDC</h1>
      <button onClick={connectPhantom} disabled={isLoading}>
        {isLoading ? "Connecting..." : "🔗 Connect Phantom"}
      </button>
      <button onClick={payAndFetch} disabled={isLoading || !provider}>
        {isLoading ? "Processing..." : "💸 Pay & Fetch /weather"}
      </button>
      <h2>{output}</h2>
    </div>
  );
};

export default Wallet;
