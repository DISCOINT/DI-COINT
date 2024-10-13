import { Injectable } from '@nestjs/common';
import web3, { PublicKey, sendAndConfirmTransaction, SystemProgram } from '@solana/web3.js';
import { getMint, mintTo, burn, getOrCreateAssociatedTokenAccount, TYPE_SIZE, LENGTH_SIZE, getMintLen, ExtensionType, TOKEN_2022_PROGRAM_ID, createInitializeMetadataPointerInstruction, createInitializeMintInstruction, transfer, AccountLayout } from '@solana/spl-token';
import base58 from 'bs58';
import { createInitializeInstruction, createUpdateFieldInstruction, pack, TokenMetadata } from '@solana/spl-token-metadata';
import fs from 'fs';

@Injectable()
export class SolanaConnectionService {
  connection: web3.Connection;
  walletFilePath: string;
  mainNet: boolean;
  wallet: web3.Keypair;

  constructor() {
    this.connection = new web3.Connection(web3.clusterApiUrl("devnet"), { commitment: "confirmed" });
    this.mainNet = false;
    this.walletFilePath = 'solWallet.json';
    this.wallet = this._getOrCreateWallet();

}

_getOrCreateWallet() {
    try {
        if (fs.existsSync(this.walletFilePath)) {
            const walletData = JSON.parse(fs.readFileSync(this.walletFilePath, 'utf8'));
            const wallet =  web3.Keypair.fromSecretKey(new Uint8Array(walletData.privateKey));
            console.log("Loaded existing SOL wallet: ", wallet.publicKey.toBase58());
            
            return wallet
        } else {
            const wallet = web3.Keypair.generate();
            const walletJson = { privateKey: Array.from(wallet.secretKey) };
            fs.writeFileSync(this.walletFilePath, JSON.stringify(walletJson), 'utf-8');
            console.log("Created new wallet");
            return wallet;
        }
    } catch (error) {
        console.error('Error loading or creating wallet:', error);
        throw {message: `Error reading or creating solana wallet: ${error.message}`, status: 500};
    }
}

createWallet() {
    const walletBase = web3.Keypair.generate();
    const privateKey = base58.encode(walletBase.secretKey)
    const address = walletBase.publicKey.toBase58()

    return {
        privateKey,
        address
    }
}

async deployTokenContract(tokenName, tokenSymbol, image) {
    const mintKeypair = web3.Keypair.generate();
    const mint = mintKeypair.publicKey;
    const decimals = 9;

    const metaData: TokenMetadata = {
        updateAuthority: this.wallet.publicKey,
        mint: mint,
        name: tokenName,
        symbol: tokenSymbol,
        uri: image,
        additionalMetadata: [["description", "Only Possible On Solana"]],
    };

    // Size of MetadataExtension 2 bytes for type, 2 bytes for length
    const metadataExtension = TYPE_SIZE + LENGTH_SIZE;
    // Size of metadata
    const metadataLen = pack(metaData).length;
    
    // Size of Mint Account with extension
    const mintLen = getMintLen([ExtensionType.MetadataPointer]);
    
    // Minimum lamports required for Mint Account
    const lamports = await this.connection.getMinimumBalanceForRentExemption(
        mintLen + metadataExtension + metadataLen,
    );

    const createAccountInstruction = SystemProgram.createAccount({
        fromPubkey: this.wallet.publicKey, // Account that will transfer lamports to created account
        newAccountPubkey: mint, // Address of the account to create
        space: mintLen, // Amount of bytes to allocate to the created account
        lamports, // Amount of lamports transferred to created account
        programId: TOKEN_2022_PROGRAM_ID, // Program assigned as owner of created account
    });

    // Instruction to initialize the MetadataPointer Extension
    const initializeMetadataPointerInstruction = createInitializeMetadataPointerInstruction(
        mint, // Mint Account address
        this.wallet.publicKey, // Authority that can set the metadata address
        mint, // Account address that holds the metadata
        TOKEN_2022_PROGRAM_ID,
    );

    // Instruction to initialize Mint Account data
    const initializeMintInstruction = createInitializeMintInstruction(
        mint, // Mint Account Address
        decimals, // Decimals of Mint
        this.wallet.publicKey, // Designated Mint Authority
        this.wallet.publicKey, // Optional Freeze Authority
        TOKEN_2022_PROGRAM_ID, // Token Extension Program ID
    );

    // Instruction to initialize Metadata Account data
    const initializeMetadataInstruction = createInitializeInstruction({
        programId: TOKEN_2022_PROGRAM_ID, // Token Extension Program as Metadata Program
        metadata: mint, // Account address that holds the metadata
        updateAuthority: this.wallet.publicKey, // Authority that can update the metadata
        mint: mint, // Mint Account address
        mintAuthority: this.wallet.publicKey, // Designated Mint Authority
        name: metaData.name,
        symbol: metaData.symbol,
        uri: metaData.uri,
    });

    const updateFieldInstruction = createUpdateFieldInstruction({
        programId: TOKEN_2022_PROGRAM_ID, // Token Extension Program as Metadata Program
        metadata: mint, // Account address that holds the metadata
        updateAuthority: this.wallet.publicKey, // Authority that can update the metadata
        field: metaData.additionalMetadata[0][0], // key
        value: metaData.additionalMetadata[0][1], // value
    });

      // Add instructions to new transaction
    const transaction = new web3.Transaction().add(
        createAccountInstruction,
        initializeMetadataPointerInstruction,
        // note: the above instructions are required before initializing the mint
        initializeMintInstruction,
        initializeMetadataInstruction,
        updateFieldInstruction,
    );
    
    // Send transaction
    const transactionSignature = await sendAndConfirmTransaction(
        this.connection,
        transaction,
        [this.wallet, mintKeypair], // Signers
    );
    
    console.log(
        "\nCreate Mint Account:",
        `https://solana.fm/tx/${transactionSignature}?cluster=devnet-solana`,
    );

    return mint.toBase58()
}

getVaultWalletAddress() {
    return this.wallet.publicKey.toBase58()
}

async getTokenInstanceAndDecimals(token_address) {
    try {
        const mint = new web3.PublicKey(token_address);
        const mintInfo = await getMint(this.connection, mint, 'confirmed', TOKEN_2022_PROGRAM_ID);

        return {contract: mint, decimals: mintInfo.decimals}
        return mintInfo;
    } catch (error) {
        console.error('Error loading contract:', error);
        throw error;
    }
}

async getATC(payer, mint, owner) {
    return await getOrCreateAssociatedTokenAccount(
        this.connection,
        payer,           // payer
        mint,
        owner,  // owner
        null,
        null,
        null,
        TOKEN_2022_PROGRAM_ID
    );
}

async getSolBalance() {
    try {
        return await this.connection.getBalance(this.wallet.publicKey);
    } catch (error) {
        console.error('Error getting SOL balance:', error);
        throw error;
    }
}

async mintTokensToUser(tokenAddress, toAddress, amount) {
    try {
        const mint = new web3.PublicKey(tokenAddress);
        const to = new web3.PublicKey(toAddress);

        const tokenAccount = await this.getATC(
            this.wallet,            // payer (service wallet pays for the transaction)
            mint,                   // mintAddress
            to,                      // owner (the third-party wallet receiving tokens)
        );

        const mintInfo = await getMint(this.connection, mint, null, TOKEN_2022_PROGRAM_ID);
        const adjustedAmount = amount * Math.pow(10, mintInfo.decimals);


        const tx: web3.TransactionSignature= await mintTo(
            this.connection,         // connection
            this.wallet,             // payer (service wallet pays for the transaction)
            mint,                    // mintAddress
            tokenAccount.address,    // destination
            this.wallet.publicKey,   // authority (service wallet is the mint authority)
            adjustedAmount,          // Adjust for 9 decimal places
            [this.wallet],
            undefined,
            TOKEN_2022_PROGRAM_ID
        );

        await this.connection.confirmTransaction(tx, 'finalized');

        return tx
        console.log(`Minted ${amount} tokens to ${toAddress}`);
    } catch (error) {
        console.error('Error minting tokens:', error);
        throw error;
    }
}

async burnTokensFromUser(tokenAddress, wallet, amount) {
    try {
        const walletSecretKey = base58.decode(wallet)
        const mint = new web3.PublicKey(tokenAddress);
        
        let userWallet;
        try {
            userWallet = web3.Keypair.fromSecretKey(new Uint8Array(walletSecretKey));
        } catch (error) {
            throw {message: "Invalid secret key provided for burnTokensFromUser", status: 400 };
        }
        const tokenAccount = await this.getATC(
            this.wallet,           // payer (service wallet pays for the transaction)
            mint,
            userWallet.publicKey,  // owner (the third-party wallet burning tokens)
        );

        const mintInfo = await getMint(this.connection, mint, null, TOKEN_2022_PROGRAM_ID);
        const adjustedAmount = amount * Math.pow(10, mintInfo.decimals);

        const tx = await burn(
            this.connection,            // Connection
            this.wallet,                // payer (service wallet pays for the transaction)
            tokenAccount.address,       // BalanceAccount
            mint,                       // Token contract
            userWallet,                 // owner (the third-party wallet burning tokens)
            adjustedAmount,             // Adjust for 9 decimal places,
            [userWallet],
            {},
            TOKEN_2022_PROGRAM_ID       
        );

        await this.connection.confirmTransaction(tx, 'finalized');


        return tx
        //console.log(`Burned ${amount} tokens from ${userWallet.publicKey}`);
    } catch (error) {
        console.error('Error burning tokens:', error);
        throw error;
    }
}

async getWalletTokenBalance(address) {  
    const tokenAccounts = await this.connection.getTokenAccountsByOwner(
        new PublicKey(address),
        {
            programId: TOKEN_2022_PROGRAM_ID
        }
    )
    
    const tokenBalances = []

    tokenAccounts.value.forEach((tokenAccount) => {
      const accountData = AccountLayout.decode(tokenAccount.account.data);
      tokenBalances.push({
        token_address: accountData.mint.toBase58(),
        balance: accountData.amount
      })
    })

    return tokenBalances

}

async transferTokens(tokenAddress, to, amount, wallet) {
    const walletSecretKey = base58.decode(wallet);

    let userWallet;
    try {
        userWallet = web3.Keypair.fromSecretKey(new Uint8Array(walletSecretKey));
    } catch (error) {
        throw { message: "Invalid secret key provided for transferTokens", status: 400 };
    }

    try {
        const mint = new web3.PublicKey(tokenAddress);
        const toPublicKey = new web3.PublicKey(to);

        // Get the token account of the fromWallet address
        const fromTokenAccount = await this.getATC(this.wallet, mint, userWallet.publicKey);

        // Get the token account of the toWallet address
        const toTokenAccount = await this.getATC(this.wallet, mint, toPublicKey);

        // Get the mint info to calculate the adjusted amount
        const mintInfo = await getMint(this.connection, mint, null, TOKEN_2022_PROGRAM_ID);
        const adjustedAmount = amount * Math.pow(10, mintInfo.decimals);

        // Perform the transfer
        const tx = await transfer(
            this.connection,
            this.wallet,             // payer
            fromTokenAccount.address,
            toTokenAccount.address,
            userWallet.publicKey,    // owner
            adjustedAmount,
            [userWallet],
            undefined,
            TOKEN_2022_PROGRAM_ID
        );

        await this.connection.confirmTransaction(tx, 'finalized');

        return tx
        console.log(`Transferred ${amount} tokens from ${userWallet.publicKey.toBase58()} to ${to}`);
        return tx;
    } catch (error) {
        console.error('Error transferring tokens:', error);
        throw error;
    }
  }
}
