import { Field } from './field.js';
import { Gadgets } from './gadgets/gadgets.js';
import { assert } from './errors.js';
import { exists } from './gadgets/common.js';
import { rangeCheck8 } from './gadgets/range-check.js';

export { Keccak };

const Keccak = {
  /** TODO */
  nistSha3(len: 224 | 256 | 384 | 512, message: Field[]): Field[] {
    return nistSha3(len, message);
  },
  /** TODO */
  ethereum(message: Field[]): Field[] {
    return ethereum(message);
  },
  /** TODO */
  preNist(len: 224 | 256 | 384 | 512, message: Field[]): Field[] {
    return preNist(len, message);
  },
};

// KECCAK CONSTANTS

// Length of the square matrix side of Keccak states
const KECCAK_DIM = 5;

// Value `l` in Keccak, ranges from 0 to 6 and determines the lane width
const KECCAK_ELL = 6;

// Width of a lane of the state, meaning the length of each word in bits (64)
const KECCAK_WORD = 2 ** KECCAK_ELL;

// Number of bytes that fit in a word (8)
const BYTES_PER_WORD = KECCAK_WORD / 8;

// Length of the state in words, 5x5 = 25
const KECCAK_STATE_LENGTH_WORDS = KECCAK_DIM ** 2;

// Length of the state in bits, meaning the 5x5 matrix of words in bits (1600)
const KECCAK_STATE_LENGTH = KECCAK_STATE_LENGTH_WORDS * KECCAK_WORD;

// Length of the state in bytes, meaning the 5x5 matrix of words in bytes (200)
const KECCAK_STATE_LENGTH_BYTES = KECCAK_STATE_LENGTH / 8;

// Creates the 5x5 table of rotation offset for Keccak modulo 64
//  | i \ j |  0 |  1 |  2 |  3 |  4 |
//  | ----- | -- | -- | -- | -- | -- |
//  | 0     |  0 | 36 |  3 | 41 | 18 |
//  | 1     |  1 | 44 | 10 | 45 |  2 |
//  | 2     | 62 |  6 | 43 | 15 | 61 |
//  | 3     | 28 | 55 | 25 | 21 | 56 |
//  | 4     | 27 | 20 | 39 |  8 | 14 |
const ROT_TABLE = [
  [0, 36, 3, 41, 18],
  [1, 44, 10, 45, 2],
  [62, 6, 43, 15, 61],
  [28, 55, 25, 21, 56],
  [27, 20, 39, 8, 14],
];

// Round constants for Keccak
// From https://keccak.team/files/Keccak-reference-3.0.pdf
const ROUND_CONSTANTS = [
  0x0000000000000001n,
  0x0000000000008082n,
  0x800000000000808an,
  0x8000000080008000n,
  0x000000000000808bn,
  0x0000000080000001n,
  0x8000000080008081n,
  0x8000000000008009n,
  0x000000000000008an,
  0x0000000000000088n,
  0x0000000080008009n,
  0x000000008000000an,
  0x000000008000808bn,
  0x800000000000008bn,
  0x8000000000008089n,
  0x8000000000008003n,
  0x8000000000008002n,
  0x8000000000000080n,
  0x000000000000800an,
  0x800000008000000an,
  0x8000000080008081n,
  0x8000000000008080n,
  0x0000000080000001n,
  0x8000000080008008n,
];

// KECCAK HASH FUNCTION

// Computes the number of required extra bytes to pad a message of length bytes
function bytesToPad(rate: number, length: number): number {
  return rate - (length % rate);
}

// Pads a message M as:
// M || pad[x](|M|)
// The padded message will start with the message argument followed by the padding rule (below) to fulfill a length that is a multiple of rate (in bytes).
// If nist is true, then the padding rule is 0x06 ..0*..1.
// If nist is false, then the padding rule is 10*1.
function pad(message: Field[], rate: number, nist: boolean): Field[] {
  // Find out desired length of the padding in bytes
  // If message is already rate bits, need to pad full rate again
  const extraBytes = bytesToPad(rate, message.length);

  // 0x06 0x00 ... 0x00 0x80 or 0x86
  const first = nist ? 0x06n : 0x01n;
  const last = 0x80n;

  // Create the padding vector
  const pad = Array(extraBytes).fill(Field.from(0));
  pad[0] = Field.from(first);
  pad[extraBytes - 1] = pad[extraBytes - 1].add(last);

  // Return the padded message
  return [...message, ...pad];
}

// ROUND TRANSFORMATION

// First algorithm in the compression step of Keccak for 64-bit words.
// C[i] = A[i,0] xor A[i,1] xor A[i,2] xor A[i,3] xor A[i,4]
// D[i] = C[i-1] xor ROT(C[i+1], 1)
// E[i,j] = A[i,j] xor D[i]
// In the Keccak reference, it corresponds to the `theta` algorithm.
// We use the first index of the state array as the i coordinate and the second index as the j coordinate.
const theta = (state: Field[][]): Field[][] => {
  const stateA = state;

  // XOR the elements of each row together
  // for all i in {0..4}: C[i] = A[i,0] xor A[i,1] xor A[i,2] xor A[i,3] xor A[i,4]
  const stateC = stateA.map((row) =>
    row.reduce((acc, value) => Gadgets.xor(acc, value, KECCAK_WORD))
  );

  // for all i in {0..4}: D[i] = C[i-1] xor ROT(C[i+1], 1)
  const stateD = Array.from({ length: KECCAK_DIM }, (_, x) =>
    Gadgets.xor(
      stateC[(x + KECCAK_DIM - 1) % KECCAK_DIM],
      Gadgets.rotate(stateC[(x + 1) % KECCAK_DIM], 1, 'left'),
      KECCAK_WORD
    )
  );

  // for all i in {0..4} and j in {0..4}: E[i,j] = A[i,j] xor D[i]
  const stateE = stateA.map((row, index) =>
    row.map((elem) => Gadgets.xor(elem, stateD[index], KECCAK_WORD))
  );

  return stateE;
};

// Second and third steps in the compression step of Keccak for 64-bit words.
// pi: A[i,j] = ROT(E[i,j], r[i,j])
// rho: A[i,j] = A'[j, 2i+3j mod KECCAK_DIM]
// piRho: B[j,2i+3j] = ROT(E[i,j], r[i,j])
// which is equivalent to the `rho` algorithm followed by the `pi` algorithm in the Keccak reference as follows:
// rho:
// A[0,0] = a[0,0]
// | i |  =  | 1 |
// | j |  =  | 0 |
// for t = 0 to 23 do
//   A[i,j] = ROT(a[i,j], (t+1)(t+2)/2 mod 64)))
//   | i |  =  | 0  1 |   | i |
//   |   |  =  |      | * |   |
//   | j |  =  | 2  3 |   | j |
// end for
// pi:
// for i = 0 to 4 do
//   for j = 0 to 4 do
//     | I |  =  | 0  1 |   | i |
//     |   |  =  |      | * |   |
//     | J |  =  | 2  3 |   | j |
//     A[I,J] = a[i,j]
//   end for
// end for
// We use the first index of the state array as the i coordinate and the second index as the j coordinate.
function piRho(state: Field[][]): Field[][] {
  const stateE = state;
  const stateB = State.zeros();

  // for all i in {0..4} and j in {0..4}: B[y,2x+3y] = ROT(E[i,j], r[i,j])
  for (let i = 0; i < KECCAK_DIM; i++) {
    for (let j = 0; j < KECCAK_DIM; j++) {
      stateB[j][(2 * i + 3 * j) % KECCAK_DIM] = Gadgets.rotate(
        stateE[i][j],
        ROT_TABLE[i][j],
        'left'
      );
    }
  }

  return stateB;
}

// Fourth step of the compression function of Keccak for 64-bit words.
// F[i,j] = B[i,j] xor ((not B[i+1,j]) and B[i+2,j])
// It corresponds to the chi algorithm in the Keccak reference.
// for j = 0 to 4 do
//   for i = 0 to 4 do
//     A[i,j] = a[i,j] xor ((not a[i+1,j]) and a[i+2,j])
//   end for
// end for
function chi(state: Field[][]): Field[][] {
  const stateB = state;
  const stateF = State.zeros();

  // for all i in {0..4} and j in {0..4}: F[i,j] = B[i,j] xor ((not B[i+1,j]) and B[i+2,j])
  for (let i = 0; i < KECCAK_DIM; i++) {
    for (let j = 0; j < KECCAK_DIM; j++) {
      stateF[i][j] = Gadgets.xor(
        stateB[i][j],
        Gadgets.and(
          // We can use unchecked NOT because the length of the input is constrained to be 64 bits thanks to the fact that it is the output of a previous Xor64
          Gadgets.not(stateB[(i + 1) % KECCAK_DIM][j], KECCAK_WORD, false),
          stateB[(i + 2) % KECCAK_DIM][j],
          KECCAK_WORD
        ),
        KECCAK_WORD
      );
    }
  }

  return stateF;
}

// Fifth step of the permutation function of Keccak for 64-bit words.
// It takes the word located at the position (0,0) of the state and XORs it with the round constant.
function iota(state: Field[][], rc: bigint): Field[][] {
  const stateG = state;

  stateG[0][0] = Gadgets.xor(stateG[0][0], Field.from(rc), KECCAK_WORD);

  return stateG;
}

// One round of the Keccak permutation function.
// iota o chi o pi o rho o theta
function round(state: Field[][], rc: bigint): Field[][] {
  const stateA = state;
  const stateE = theta(stateA);
  const stateB = piRho(stateE);
  const stateF = chi(stateB);
  const stateD = iota(stateF, rc);
  return stateD;
}

// Keccak permutation function with a constant number of rounds
function permutation(state: Field[][], rc: bigint[]): Field[][] {
  return rc.reduce((acc, value) => round(acc, value), state);
}

// KECCAK SPONGE

// Absorb padded message into a keccak state with given rate and capacity
function absorb(
  paddedMessage: Field[],
  capacity: number,
  rate: number,
  rc: bigint[]
): State {
  assert(
    rate + capacity === KECCAK_STATE_LENGTH_WORDS,
    `invalid rate or capacity (rate + capacity should be ${KECCAK_STATE_LENGTH_WORDS})`
  );
  assert(
    paddedMessage.length % rate === 0,
    'invalid padded message length (should be multiple of rate)'
  );

  let state = State.zeros();

  // array of capacity zero bytes
  const zeros = Array(capacity).fill(Field.from(0));

  for (let idx = 0; idx < paddedMessage.length; idx += rate) {
    // split into blocks of rate bits
    // for each block of rate bits in the padded message -> this is rate bytes
    const block = paddedMessage.slice(idx, idx + rate);
    // pad the block with 0s to up to KECCAK_STATE_LENGTH_WORDS words
    const paddedBlock = block.concat(zeros);
    // convert the padded block to a Keccak state
    const blockState = State.fromWords(paddedBlock);
    // xor the state with the padded block
    const stateXor = State.xor(state, blockState);
    // apply the permutation function to the xored state
    state = permutation(stateXor, rc);
  }
  return state;
}

// Squeeze state until it has a desired length in words
function squeeze(state: State, length: number, rate: number): Field[] {
  // number of squeezes
  const squeezes = Math.floor(length / rate) + 1;
  assert(squeezes === 1, 'squeezes should be 1');

  // first state to be squeezed
  const words = State.toWords(state);

  // Obtain the hash selecting the first `length` words of the output array
  const hashed = words.slice(0, length);
  return hashed;
}

// Keccak sponge function for 200 bytes of state width
function sponge(
  paddedMessage: Field[],
  length: number,
  capacity: number,
  rate: number
): Field[] {
  // check that the padded message is a multiple of rate
  assert(paddedMessage.length % rate === 0, 'Invalid padded message length');

  // absorb
  const state = absorb(paddedMessage, capacity, rate, ROUND_CONSTANTS);

  // squeeze
  const hashed = squeeze(state, length, rate);

  return hashed;
}

// Keccak hash function with input message passed as list of Field bytes.
// The message will be parsed as follows:
// - the first byte of the message will be the least significant byte of the first word of the state (A[0][0])
// - the 10*1 pad will take place after the message, until reaching the bit length rate.
// - then, {0} pad will take place to finish the 200 bytes of the state.
function hash(
  message: Field[],
  length: number,
  capacity: number,
  nistVersion: boolean
): Field[] {
  // Throw errors if used improperly
  assert(capacity > 0, 'capacity must be positive');
  assert(
    capacity < KECCAK_STATE_LENGTH_BYTES,
    `capacity must be less than ${KECCAK_STATE_LENGTH_BYTES}`
  );
  assert(length > 0, 'length must be positive');

  // convert capacity and length to word units
  assert(capacity % BYTES_PER_WORD === 0, 'length must be a multiple of 8');
  capacity /= BYTES_PER_WORD;
  assert(length % BYTES_PER_WORD === 0, 'length must be a multiple of 8');
  length /= BYTES_PER_WORD;

  const rate = KECCAK_STATE_LENGTH_WORDS - capacity;

  // apply padding, convert to words, and hash
  const paddedBytes = pad(message, rate * BYTES_PER_WORD, nistVersion);
  const padded = bytesToWords(paddedBytes);

  const hash = sponge(padded, length, capacity, rate);
  const hashBytes = wordsToBytes(hash);

  return hashBytes;
}

// Gadget for NIST SHA-3 function for output lengths 224/256/384/512.
function nistSha3(len: 224 | 256 | 384 | 512, message: Field[]): Field[] {
  return hash(message, len / 8, len / 4, true);
}

// Gadget for pre-NIST SHA-3 function for output lengths 224/256/384/512.
// Note that when calling with output length 256 this is equivalent to the ethereum function
function preNist(len: 224 | 256 | 384 | 512, message: Field[]): Field[] {
  return hash(message, len / 8, len / 4, false);
}

// Gadget for Keccak hash function for the parameters used in Ethereum.
function ethereum(message: Field[]): Field[] {
  return preNist(256, message);
}

// FUNCTIONS ON KECCAK STATE

type State = Field[][];
const State = {
  /**
   * Create a state of all zeros
   */
  zeros(): State {
    return Array.from(Array(KECCAK_DIM), (_) =>
      Array(KECCAK_DIM).fill(Field.from(0))
    );
  },

  /**
   * Flatten state to words
   */
  toWords(state: State): Field[] {
    const words = Array<Field>(KECCAK_STATE_LENGTH_WORDS);
    for (let j = 0; j < KECCAK_DIM; j++) {
      for (let i = 0; i < KECCAK_DIM; i++) {
        words[KECCAK_DIM * j + i] = state[i][j];
      }
    }
    return words;
  },

  /**
   * Compose words to state
   */
  fromWords(words: Field[]): State {
    const state = State.zeros();
    for (let j = 0; j < KECCAK_DIM; j++) {
      for (let i = 0; i < KECCAK_DIM; i++) {
        state[i][j] = words[KECCAK_DIM * j + i];
      }
    }
    return state;
  },

  /**
   * XOR two states together and return the result
   */
  xor(a: State, b: State): State {
    assert(
      a.length === KECCAK_DIM && a[0].length === KECCAK_DIM,
      `invalid \`a\` dimensions (should be ${KECCAK_DIM})`
    );
    assert(
      b.length === KECCAK_DIM && b[0].length === KECCAK_DIM,
      `invalid \`b\` dimensions (should be ${KECCAK_DIM})`
    );

    // Calls Gadgets.xor on each pair (i,j) of the states input1 and input2 and outputs the output Fields as a new matrix
    return a.map((row, i) =>
      row.map((value, j) => Gadgets.xor(value, b[i][j], 64))
    );
  },
};

// AUXILARY FUNCTIONS

// Auxiliary functions to check the composition of 8 byte values (LE) into a 64-bit word and create constraints for it

function bytesToWord(wordBytes: Field[]): Field {
  return wordBytes.reduce((acc, value, idx) => {
    const shift = 1n << BigInt(8 * idx);
    return acc.add(value.mul(shift));
  }, Field.from(0));
}

function wordToBytes(word: Field): Field[] {
  let bytes = exists(BYTES_PER_WORD, () => {
    let w = word.toBigInt();
    return Array.from(
      { length: BYTES_PER_WORD },
      (_, k) => (w >> BigInt(8 * k)) & 0xffn
    );
  });
  // range-check
  // TODO(jackryanservia): Use lookup argument once issue is resolved
  bytes.forEach(rangeCheck8);

  // check decomposition
  bytesToWord(bytes).assertEquals(word);

  return bytes;
}

function bytesToWords(bytes: Field[]): Field[] {
  return chunk(bytes, BYTES_PER_WORD).map(bytesToWord);
}

function wordsToBytes(words: Field[]): Field[] {
  return words.flatMap(wordToBytes);
}

function chunk<T>(array: T[], size: number): T[][] {
  assert(array.length % size === 0, 'invalid input length');
  return Array.from({ length: array.length / size }, (_, i) =>
    array.slice(size * i, size * (i + 1))
  );
}
