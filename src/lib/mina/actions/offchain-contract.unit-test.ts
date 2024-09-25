import {
  SmartContract,
  method,
  state,
  PublicKey,
  UInt64,
  Experimental,
} from '../../../index.js';
import { contract } from '../smart-contract-context.js';
import { expectState, testLocal, transaction } from '../test/test-contract.js';

const { OffchainState } = Experimental;

const offchainState = OffchainState(
  {
    accounts: OffchainState.Map(PublicKey, UInt64),
    totalSupply: OffchainState.Field(UInt64),
  },
  { logTotalCapacity: 10, maxActionsPerProof: 5 }
);

class StateProof extends offchainState.Proof {}

// example contract that interacts with offchain state
class ExampleContract extends SmartContract {
  @state(OffchainState.Commitments) offchainStateCommitments =
    offchainState.emptyCommitments();

  offchainState = offchainState.init(this);

  @method
  async createAccount(address: PublicKey, amountToMint: UInt64) {
    // setting `from` to `undefined` means that the account must not exist yet
    this.offchainState.fields.accounts.update(address, {
      from: undefined,
      to: amountToMint,
    });

    // TODO using `update()` on the total supply means that this method
    // can only be called once every settling cycle
    let totalSupplyOption = await this.offchainState.fields.totalSupply.get();
    let totalSupply = totalSupplyOption.orElse(0n);

    this.offchainState.fields.totalSupply.update({
      from: totalSupplyOption,
      to: totalSupply.add(amountToMint),
    });
  }

  @method
  async transfer(from: PublicKey, to: PublicKey, amount: UInt64) {
    let fromOption = await this.offchainState.fields.accounts.get(from);
    let fromBalance = fromOption.assertSome('sender account exists');

    let toOption = await this.offchainState.fields.accounts.get(to);
    let toBalance = toOption.orElse(0n);

    /**
     * Update both accounts atomically.
     *
     * This is safe, because both updates will only be accepted if both previous balances are still correct.
     */
    this.offchainState.fields.accounts.update(from, {
      from: fromOption,
      to: fromBalance.sub(amount),
    });
    this.offchainState.fields.accounts.update(to, {
      from: toOption,
      to: toBalance.add(amount),
    });
  }

  @method.returns(UInt64)
  async getSupply() {
    return (await this.offchainState.fields.totalSupply.get()).orElse(0n);
  }

  @method.returns(UInt64)
  async getBalance(address: PublicKey) {
    return (await this.offchainState.fields.accounts.get(address)).orElse(0n);
  }

  @method
  async settle(proof: StateProof) {
    await this.offchainState.settle(proof);
  }
}

// connect contract to offchain state
// offchainState.setContractClass(ExampleContract);

// test code below

await testLocal(
  ExampleContract,
  { proofsEnabled: true, offchainState },
  ({ accounts: { sender, receiver, other }, contract, Local }) => [
    // create first account
    transaction('create account', async () => {
      // first call (should succeed)
      await contract.createAccount(sender, UInt64.from(1000));

      // second call (should fail)
      await contract.createAccount(sender, UInt64.from(2000));
    }),

    // settle
    async () => {
      console.time('settlement proof 1');
      let proof = await contract.offchainState.createSettlementProof();
      console.timeEnd('settlement proof 1');

      return transaction('settle 1', () => contract.settle(proof));
    },

    // check balance and supply
    expectState(offchainState.fields.totalSupply, 1000n),
    expectState(offchainState.fields.accounts, [sender, 1000n]),
    expectState(offchainState.fields.accounts, [receiver, undefined]),

    // transfer (should succeed)
    transaction('transfer', () =>
      contract.transfer(sender, receiver, UInt64.from(100))
    ),

    // we run some calls without proofs to save time
    () => Local.setProofsEnabled(false),

    // more transfers that should fail
    transaction('more transfers', async () => {
      // (these are enough to need two proof steps during settlement)
      await contract.transfer(sender, receiver, UInt64.from(200));
      await contract.transfer(sender, receiver, UInt64.from(300));
      await contract.transfer(sender, receiver, UInt64.from(400));

      // create another account (should succeed)
      await contract.createAccount(other, UInt64.from(555));

      // create existing account again (should fail)
      await contract.createAccount(receiver, UInt64.from(333));
    }),

    // settle
    async () => {
      Local.resetProofsEnabled();
      console.time('settlement proof 2');
      let proof = await contract.offchainState.createSettlementProof();
      console.timeEnd('settlement proof 2');

      return transaction('settle 2', () => contract.settle(proof));
    },

    // check balance and supply
    expectState(contract.offchainState.fields.totalSupply, 1555n),
    expectState(contract.offchainState.fields.accounts, [sender, 900n]),
    expectState(contract.offchainState.fields.accounts, [receiver, 100n]),
  ]
);
