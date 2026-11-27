import { describe, expect, it } from 'vitest';
import { parseUpiQr } from './upiQr';

describe('Reading a centre UPI QR', () => {
  it('reads a normal UPI QR', () => {
    expect(parseUpiQr('upi://pay?pa=xsarena@okaxis&pn=XS%20Arena&cu=INR')).toEqual({ upiId: 'xsarena@okaxis', payee: 'XS Arena' });
    expect(parseUpiQr('UPI://pay?pn=Cue+Corner&pa=9847012345@ybl')).toEqual({ upiId: '9847012345@ybl', payee: 'Cue Corner' });
  });
  it('reads a merchant QR without a name', () => {
    expect(parseUpiQr('upi://pay?pa=paytmqr2810050501011abc@paytm&mc=5816&mode=02')).toEqual({ upiId: 'paytmqr2810050501011abc@paytm', payee: null });
  });
  it('reads a Bharat QR', () => {
    const emv = '000201010211' + '2631' + '0010A000000524' + '0113cuecorner@sbi' + '52045816' + '5303356' + '5802IN' + '5910CUE CORNER' + '6005KOCHI' + '6304ABCD';
    expect(parseUpiQr(emv)).toEqual({ upiId: 'cuecorner@sbi', payee: 'CUE CORNER' });
  });
  it('rejects QRs that are not UPI', () => {
    expect(parseUpiQr('https://example.com')).toBeNull();
    expect(parseUpiQr('upi://pay?pn=NoId')).toBeNull();
    expect(parseUpiQr('')).toBeNull();
    expect(parseUpiQr(null)).toBeNull();
  });
});
