import { describe, expect, it } from 'vitest';
import { classify, parseAmountAgorot, parseCsv, parseDate } from '../src/money.ts';
import { makeApp, ymd } from './helpers.ts';

describe('amount and date parsing (integer agorot, no floats)', () => {
  it.each([
    ['1,234.56', 123456], ['-12.5', -1250], ['(12.50)', -1250], ['₪ 99', 9900], ['1234,56', 123456], ['1.234,56', 123456], ['0.07', 7], ['12-', -1200], ['+3.10', 310],
  ])('parses %s', (raw, want) => expect(parseAmountAgorot(raw)).toBe(want));
  it.each(['', 'abc', '1.2.3', '12.345', '--5'])('rejects %s', (raw) => expect(parseAmountAgorot(raw)).toBeNull());
  it('has no floating point drift', () => { expect(parseAmountAgorot('0.1')! + parseAmountAgorot('0.2')!).toBe(30); });
  it('parses ISO and Israeli dates and rejects impossible ones', () => {
    expect(parseDate('2026-10-09')).toBe('2026-10-09'); expect(parseDate('09/10/2026')).toBe('2026-10-09'); expect(parseDate('9.10.26')).toBe('2026-10-09');
    expect(parseDate('2026-02-30')).toBeNull(); expect(parseDate('hello')).toBeNull();
  });
  it('handles quoted fields, embedded quotes and BOM', () => {
    expect(parseCsv('﻿a,b\n"x,1","he said ""hi"""\n')).toEqual([['a', 'b'], ['x,1', 'he said "hi"']]);
    expect(parseCsv('a,b\nע"מ,1\n')[1]).toEqual(['ע"מ', '1']);
  });
});

describe('classification keeps transfers, settlements and loan principal out of spending', () => {
  it('distinguishes kinds', () => {
    expect(classify('העברה לחיסכון', -100000).kind).toBe('transfer');
    expect(classify('חיוב כרטיס אשראי ויזה תשלום', -300000).kind).toBe('card-settlement');
    expect(classify('הלוואה קרן', -72000).kind).toBe('loan-principal');
    expect(classify('הלוואה ריבית', -18000).kind).toBe('loan-interest');
    expect(classify('החזר מחנות', 12000).kind).toBe('refund');
    expect(classify('משכורת', 1200000)).toEqual({ kind: 'income', category: 'הכנסה' });
    expect(classify('שופרסל', -5000)).toEqual({ kind: 'expense', category: 'מכולת' });
  });
});

describe('CSV import', () => {
  const header = 'date,description,amount,currency\n';
  it('is idempotent: re-importing the same file inserts nothing', () => {
    const app = makeApp();
    const csv = `${header}2026-10-01,קפה,-12.00,ILS\n2026-10-02,סופר,-80.00,ILS\n`;
    expect(app.money.import(csv, 'עו"ש').inserted).toBe(2);
    const again = app.money.import(csv, 'עו"ש');
    expect(again.inserted).toBe(0); expect(again.duplicatesSkipped).toBe(2);
    expect(app.money.count()).toBe(2);
    app.close();
  });
  it('keeps two identical purchases in one file but flags the repeat as a suspected duplicate (never deletes)', () => {
    const app = makeApp();
    const r = app.money.import(`${header}2026-10-01,קפה,-12.00,ILS\n2026-10-01,קפה,-12.00,ILS\n`, 'עו"ש');
    expect(r.inserted).toBe(2); expect(r.possibleDuplicates).toBe(1);
    expect(app.money.view().transactions.filter((t) => t.possibleDuplicateOf)).toHaveLength(1);
    app.close();
  });
  it('flags a cross-source duplicate (same amount, ±1 day) without removing either record', () => {
    const app = makeApp();
    app.money.import(`${header}2026-10-01,CAFE TLV,-12.00,ILS\n`, 'כרטיס');
    const r = app.money.import(`${header}2026-10-02,קפה תל אביב,-12.00,ILS\n`, 'כרטיס');
    expect(r.possibleDuplicates).toBe(1); expect(app.money.count()).toBe(2);
    app.close();
  });
  it('rejects bad rows with row numbers but still imports the good ones', () => {
    const app = makeApp();
    const r = app.money.import(`${header}not-a-date,x,-1,ILS\n2026-10-03,ok,-5,ILS\n2026-10-04,,-5,ILS\n2026-10-05,bad,abc,ILS\n2026-10-06,cur,-5,shekel\n`, 'עו"ש');
    expect(r.inserted).toBe(1); expect(r.rejected.map((x) => x.row)).toEqual([2, 4, 5, 6]);
    app.close();
  });
  it('supports debit/credit columns and Hebrew headers', () => {
    const app = makeApp();
    const r = app.money.import('תאריך,תיאור,חובה,זכות\n01/10/2026,סופר,100.00,\n02/10/2026,החזר,,40.00\n', 'עו"ש');
    expect(r.inserted).toBe(2);
    expect(app.money.transactions().map((t) => t.amountAgorot).sort((a, b) => a - b)).toEqual([-10000, 4000]);
    app.close();
  });
  it('refuses a file without the required columns', () => {
    const app = makeApp();
    expect(app.money.import('foo,bar\n1,2\n', 'x').rejected[0]!.reason).toMatch(/עמודות/);
    app.close();
  });
});

describe('budget recomputation', () => {
  it('counts only real spending: excludes transfers, card settlements and loan principal; refunds reduce spend; confirmed duplicates drop out', () => {
    const app = makeApp();
    const d = ymd();
    app.money.import(`date,description,amount\n${d},שופרסל,-100.00\n${d},שופרסל,-40.00\n${d},החזר שופרסל,10.00\n${d},העברה לחיסכון,-500.00\n${d},חיוב כרטיס אשראי ויזה תשלום,-900.00\n${d},הלוואה קרן,-300.00\n${d},הלוואה ריבית,-25.00\n${d},משכורת,9000.00\n`, 'עו"ש');
    app.money.setBudget('מכולת', 50000);
    const v = app.money.view();
    expect(v.budget.find((b) => b.category === 'מכולת')!.spentAgorot).toBe(13000); // 100 + 40 - 10 refund
    expect(v.budget.find((b) => b.category === 'ריבית')!.spentAgorot).toBe(2500);
    expect(v.budget.some((b) => ['העברות', 'סילוק כרטיס', 'החזר הלוואה'].includes(b.category) && b.spentAgorot > 0)).toBe(false);
    app.close();
  });
});

describe('empty state honesty', () => {
  it('shows no balances or spending until data exists', () => {
    const app = makeApp();
    const v = app.money.view();
    expect(v).toMatchObject({ hasData: false, asOf: null, balances: [], transactions: [] });
    expect(v.emptyReasonHe).toBeTruthy();
    app.close();
  });
});
