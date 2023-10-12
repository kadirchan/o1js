import { Field } from '../field.js';
import { Provable } from '../provable.js';
import * as Gates from '../gates.js';

export { xor };

/**
 * Boolean Xor of length bits
 * input1 and input2 are the inputs to the Xor gate
 * length is the number of bits to Xor
 * len_xor is the number of bits of the lookup table (default is 4)
 */
function xor(a: Field, b: Field, length: number, len_xor = 4) {
  // check that both input lengths are positive
  assert(
    length > 0 && len_xor > 0,
    `Length ${length} exceeds maximum of ${Field.sizeInBits()} bits.`
  );

  // check that length does not exceed maximum field size in bits
  assert(
    length <= Field.sizeInBits(),
    'Length exceeds maximum field size in bits.'
  );

  /*   if (a.isConstant() && b.isConstant()) {
    throw Error('TODO constant case');
  }
 */
  // create two input arrays of length 255 set to false
  let input1Array = new Array(length).fill(false);
  let input2Array = new Array(length).fill(false);

  // sanity check as prover about lengths of inputs
  Provable.asProver(() => {
    // check real lengths are at most the desired length
    fitsInBits(a, length);
    fitsInBits(b, length);

    // converts input field elements to list of bits of length 255
    let input1Bits = a.toBits();
    let input2Bits = b.toBits();

    // iterate over 255 positions to update value of arrays
    for (let i = 0; i < Field.sizeInBits() - 1; i++) {
      input1Array[i] = input1Bits[i];
      input2Array[i] = input2Bits[i];
    }
  });

  let outputXor = Provable.witness(Field, () => {
    // check real lengths are at most the desired length
    fitsInBits(a, length);
    fitsInBits(b, length);

    // converts input field elements to list of bits of length 255
    let input1Bits = a.toBits();
    let input2Bits = b.toBits();

    let outputBits = input1Bits.map((bit, i) => {
      let b1 = bit;
      let b2 = input2Bits[i];
      return b1.equals(b2).not();
    });

    // convert bits to Field
    return Field.fromBits(outputBits);
  });

  // Obtain pad length until the length is a multiple of 4*n for n-bit length lookup table
  let padLength = len_xor;
  if (length % (4 * len_xor) !== 0) {
    padLength = length + 4 * len_xor - (length % (4 * len_xor));
  }

  // recurisvely build xor gadget

  xorRec(a, b, outputXor, padLength, len_xor);
  // convert back to field
  return outputXor;
}

// builds xor chain recurisvely
function xorRec(
  input1: Field,
  input2: Field,
  outputXor: Field,
  padLength: number,
  len_xor: number
) {
  // if inputs are zero and length is zero, add the zero check

  if (padLength == 0) {
    Gates.zeroCheck(input1, input2, outputXor);

    let zero = new Field(0);
    zero.assertEquals(input1);
    zero.assertEquals(input2);
    zero.assertEquals(outputXor);
  } else {
    function ofBits(f: Field, start: number, stop: number) {
      if (stop !== -1 && stop <= start)
        throw Error('Stop offste must be greater than start offset');

      return Provable.witness(Field, () => fieldBitsToFieldLE(f, start, stop));
    }

    // nibble offsets
    let first = len_xor;
    let second = first + len_xor;
    let third = second + len_xor;
    let fourth = third + len_xor;

    let in1_0 = ofBits(input1, 0, first);
    let in1_1 = ofBits(input1, first, second);
    let in1_2 = ofBits(input1, second, third);
    let in1_3 = ofBits(input1, third, fourth);
    let in2_0 = ofBits(input2, 0, first);
    let in2_1 = ofBits(input2, first, second);
    let in2_2 = ofBits(input2, second, third);
    let in2_3 = ofBits(input2, third, fourth);
    let out_0 = ofBits(outputXor, 0, first);
    let out_1 = ofBits(outputXor, first, second);
    let out_2 = ofBits(outputXor, second, third);
    let out_3 = ofBits(outputXor, third, fourth);

    Gates.xor(
      input1,
      input2,
      outputXor,
      in1_0,
      in1_1,
      in1_2,
      in1_3,
      in2_0,
      in2_1,
      in2_2,
      in2_3,
      out_0,
      out_1,
      out_2,
      out_3
    );

    let next_in1 = asProverNextVar(input1, in1_0, in1_1, in1_2, in1_3, len_xor);

    let next_in2 = asProverNextVar(input2, in2_0, in2_1, in2_2, in2_3, len_xor);

    let next_out = asProverNextVar(
      outputXor,
      out_0,
      out_1,
      out_2,
      out_3,
      len_xor
    );

    let next_length = padLength - 4 * len_xor;
    xorRec(next_in1, next_in2, next_out, next_length, len_xor);
  }
}

function assert(stmt: boolean, message?: string) {
  if (!stmt) {
    throw Error(message ?? 'Assertion failed');
  }
}

function fitsInBits(word: Field, length: number) {
  Provable.asProver(() => {
    assert(word.toBigInt() < 2 ** length, 'Word does not fit in bits');
  });
}

function fieldBitsToFieldLE(f: Field, start: number, stop: number) {
  if (stop !== -1 && stop <= start)
    throw Error('stop offset must be greater than start offset');

  let bits = f.toBits();

  if (stop > bits.length) throw Error('stop must be less than bit-length');

  if (stop === -1) stop = bits.length;

  return Field.fromBits(bits.slice(start, stop));
}

function asProverNextVar(
  current: Field,
  var0: Field,
  var1: Field,
  var2: Field,
  var3: Field,
  len_xor: number
) {
  let twoPowLen = new Field(2 ** len_xor);

  let twoPow2Len = twoPowLen.mul(twoPowLen);
  let twoPow3Len = twoPow2Len.mul(twoPowLen);
  let twoPow4Len = twoPow3Len.mul(twoPowLen);

  let nextVar = Provable.witness(Field, () => {
    return current
      .sub(var0)
      .sub(var1.mul(twoPowLen))
      .sub(var2.mul(twoPow2Len))
      .sub(var3.mul(twoPow3Len))
      .div(twoPow4Len);
  });

  return nextVar;
}
