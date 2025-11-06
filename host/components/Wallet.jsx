import { useState } from "react";
import { Buffer } from 'buffer'

import {
  TransactionInstruction,  PublicKey, Transaction, Connection
} from "@solana/web3.js";
import { ComputeBudgetProgram } from "@solana/web3.js";
import {
  getAssociatedTokenAddress,
  createTransferCheckedInstruction,
} from "@solana/spl-token";

/**
 * React component for interacting with Phantom wallet and making x402 payments.
 * Allows users to connect their wallet and pay for API calls with USDC.
 */
const Wallet = () => {
  // State for wallet provider and connection
  const [provider, setProvider] = useState(null);
  const [connection, setConnection] = useState(null);
  // State for displaying output messages
  const [output, setOutput] = useState("");
  // State for loading indicator
  const [isLoading, setIsLoading] = useState(false);

  // Configuration from environment variables (Vite uses import.meta.env)
  const RPC = import.meta.env.VITE_RPC_ENDPOINT || "https://api.mainnet-beta.solana.com";
  const USDC_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
  const MERCHANT_TOKEN_ACCOUNT = import.meta.env.VITE_MERCHANT_TOKEN_ACCOUNT ? new PublicKey(import.meta.env.VITE_MERCHANT_TOKEN_ACCOUNT) : null;
  const PRICE = 10000; // 0.01 USDC

  /**
   * Connects to the Phantom wallet extension.
   * Sets up the provider and Solana connection if successful.
   */
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

  /**
   * Creates and signs a Solana transaction for the payment.
   * Includes USDC transfer, memo, and compute budget instructions.
   * @returns {object} Object containing the signed transaction and reference ID.
   */
  const createPaymentTransaction = async () => {
    // Get the buyer's associated token account for USDC
    const buyerATA = await getAssociatedTokenAddress(
      USDC_MINT,
      provider.publicKey,
    );

    // Create a new transaction with recent blockhash
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
        6, // USDC has 6 decimals
      ),
    );

    // Generate a unique reference for the payment
    const ref = crypto.randomUUID();
    // Add memo instruction with x402 reference
    tx.add(
      new TransactionInstruction({
        keys: [],
        programId: new PublicKey(
          "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr", // Solana memo program
        ),
        data: new TextEncoder().encode(`x402:${ref}`),
      }),
    );

    // Add compute budget instructions for efficient execution
    tx.add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 130_000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 0 }),
    );

    // Sign the transaction with Phantom
    const signed = await provider.signTransaction(tx);
    return { signed, ref };
  };

  /**
   * Builds the x402 payment header from the signed transaction.
   * @param {Transaction} signed - The signed Solana transaction.
   * @param {string} ref - The unique reference ID.
   * @returns {string} Base64-encoded x402 header.
   */
  const buildX402Header = (signed, ref) => {
    const txBase64 = Buffer.from(signed.serialize()).toString('base64');
    return Buffer.from(
      JSON.stringify({
        x402Version: 1,
        scheme: "exact",
        network: `solana-mainnet-beta`,
        payload: { txBase64, reference: ref },
      }),
    ).toString('base64');
  };

  /**
   * Calls the weather API with the x402 payment header.
   * @param {string} xPayment - The x402 payment header.
   * @returns {object} The API response data.
   * @throws {Error} If the API call fails.
   */
  const callWeatherAPI = async (xPayment) => {
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

    return await response.json();
  };

  /**
   * Handles the full payment and API fetch flow.
   * Creates transaction, builds header, calls API, and updates UI.
   */
  const payAndFetch = async () => {
    if (!provider || !connection) {
      alert("Please connect wallet first");
      return;
    }

    setIsLoading(true);
    try {
      const { signed, ref } = await createPaymentTransaction();
      const xPayment = buildX402Header(signed, ref);
      const data = await callWeatherAPI(xPayment);
      setOutput(`Temperature: ${data.temperatureF}°F`);
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
