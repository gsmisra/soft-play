import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { InvalidTestCaseCsvError, normalizeTestCaseCsvResponse } from '../../src/agentic/csvTestCaseGenerator';

const WELL_FORMED = 'Summary,Step #,Step Explanation,Expected Result\nLogin,1,Enter valid credentials,User is logged in\nLogin,2,Click Submit,Dashboard is shown\n';

test('accepts a well-formed CSV response and re-serializes it', () => {
  const result = normalizeTestCaseCsvResponse(WELL_FORMED);
  assert.equal(result.rowCount, 2);
  assert.equal(result.columnCount, 4);
  assert.ok(result.content.startsWith('Summary,Step #,Step Explanation,Expected Result\r\n'));
});

test('strips a single outer fence the model added despite instructions not to', () => {
  const wrapped = '```csv\n' + WELL_FORMED + '```';
  const result = normalizeTestCaseCsvResponse(wrapped);
  assert.equal(result.rowCount, 2);
});

test('drops a blank trailing line rather than counting it as a data row', () => {
  const withTrailingBlank = WELL_FORMED + '\n\n';
  const result = normalizeTestCaseCsvResponse(withTrailingBlank);
  assert.equal(result.rowCount, 2);
});

test('throws InvalidTestCaseCsvError for a response with no parseable content', () => {
  assert.throws(() => normalizeTestCaseCsvResponse('   \n  \n'), InvalidTestCaseCsvError);
});

test('throws InvalidTestCaseCsvError for prose with no CSV structure at all', () => {
  assert.throws(() => normalizeTestCaseCsvResponse('Sorry, I cannot generate test cases for this request.'), InvalidTestCaseCsvError);
});

test('round-trips a cell containing a comma and an embedded quote correctly', () => {
  const raw = 'Summary,Description\n"Login, then logout","She said ""hi"" first"\n';
  const result = normalizeTestCaseCsvResponse(raw);
  assert.ok(result.content.includes('"Login, then logout"'));
  assert.ok(result.content.includes('"She said ""hi"" first"'));
});

test('a response with no template expectation given behaves exactly as before Item 7 — no new checks run', () => {
  const result = normalizeTestCaseCsvResponse(WELL_FORMED, undefined);
  assert.equal(result.populationNote, '', 'no template means nothing to note');
});

test('Item 7/F06: a column-count mismatch against a real template is a HARD error', () => {
  const template = { header: ['Summary', 'Step #', 'Step Explanation', 'Expected Result', 'Label'], exampleRows: [] };
  assert.throws(() => normalizeTestCaseCsvResponse(WELL_FORMED, template), (err: unknown) => {
    assert.ok(err instanceof InvalidTestCaseCsvError);
    assert.match((err as Error).message, /does not exactly match/);
    return true;
  });
});

test('Item 7: a matching column count against a real template with no example rows passes with no population note', () => {
  const template = { header: ['Summary', 'Step #', 'Step Explanation', 'Expected Result'], exampleRows: [] };
  const result = normalizeTestCaseCsvResponse(WELL_FORMED, template);
  assert.equal(result.columnCount, 4);
  assert.equal(result.populationNote, '');
});

test('Item 7 (soft): a data row with a blank cell where the template\'s own example row was populated gets a population note, but is NOT rejected', () => {
  const template = {
    header: ['Summary', 'Step #', 'Step Explanation', 'Expected Result'],
    exampleRows: [['Example login test', '1', 'Enter credentials', 'User is logged in']]
  };
  const responseWithBlankCell = 'Summary,Step #,Step Explanation,Expected Result\nLogin,1,Enter valid credentials,\nLogin,2,Click Submit,Dashboard is shown\n';
  const result = normalizeTestCaseCsvResponse(responseWithBlankCell, template);
  assert.equal(result.rowCount, 2, 'the response is still accepted and saved');
  assert.match(result.populationNote, /1 cell\(s\) across 1 row\(s\)/);
});

test('Item 7 (soft): every cell populated exactly like the template\'s example produces no note', () => {
  const template = {
    header: ['Summary', 'Step #', 'Step Explanation', 'Expected Result'],
    exampleRows: [['Example login test', '1', 'Enter credentials', 'User is logged in']]
  };
  const result = normalizeTestCaseCsvResponse(WELL_FORMED, template);
  assert.equal(result.populationNote, '');
});

test('F06 reproduction 1: a response whose header doesn\'t match the template at all is now rejected (previously accepted once padded)', () => {
  const template = { header: ['Summary', 'Expected Result'], exampleRows: [['x', 'y']] };
  assert.throws(() => normalizeTestCaseCsvResponse('Wrong,Headers\na,b\n', template), InvalidTestCaseCsvError);
});

test('F06 reproduction 2: a short header padded to look the right width by the OLD lenient parser is now rejected', () => {
  const template = { header: ['Summary', 'Expected Result'], exampleRows: [['x', 'y']] };
  // Serializes as "OnlyOne," followed by "a,b" — the OLD parseCsv()-based
  // check padded the header to width 2 and let this through as if
  // "OnlyOne" and "" were two real column names.
  assert.throws(() => normalizeTestCaseCsvResponse('OnlyOne\na,b\n', template), (err: unknown) => {
    assert.ok(err instanceof InvalidTestCaseCsvError);
    return true;
  });
});

test('F06: reordered headers of identical length are rejected — length alone is not enough', () => {
  const template = { header: ['Summary', 'Expected Result'], exampleRows: [] };
  assert.throws(() => normalizeTestCaseCsvResponse('Expected Result,Summary\na,b\n', template), InvalidTestCaseCsvError);
});

test('F06: a data row shorter than the header is rejected, never silently padded', () => {
  assert.throws(() => normalizeTestCaseCsvResponse('Summary,Step #,Step Explanation,Expected Result\nLogin,1,Enter credentials\n'), (err: unknown) => {
    assert.ok(err instanceof InvalidTestCaseCsvError);
    assert.match((err as Error).message, /Row 1.*3 column\(s\).*header has 4/s);
    return true;
  });
});

test('F06: a data row longer than the header is rejected', () => {
  assert.throws(
    () => normalizeTestCaseCsvResponse('Summary,Step #\nLogin,1,extra,columns\n'),
    InvalidTestCaseCsvError
  );
});

test('F06: an unterminated quote is a clear InvalidTestCaseCsvError, not silently accepted as "the rest of the file"', () => {
  assert.throws(() => normalizeTestCaseCsvResponse('Summary,Description\n"Login,unterminated\n'), InvalidTestCaseCsvError);
});

test('F06: a UTF-8 BOM on the header\'s first cell is stripped before comparison, both for the response and the template', () => {
  const template = { header: ['﻿Summary', 'Step #', 'Step Explanation', 'Expected Result'], exampleRows: [] };
  const result = normalizeTestCaseCsvResponse('﻿' + WELL_FORMED, template);
  assert.equal(result.rowCount, 2);
});

test('F06: embedded commas/newlines in a cell still round-trip correctly under strict parsing', () => {
  const raw = 'Summary,Description\n"Login, then logout","Line one\nLine two"\n';
  const result = normalizeTestCaseCsvResponse(raw);
  assert.ok(result.content.includes('"Login, then logout"'));
  assert.ok(result.content.includes('"Line one\nLine two"'));
});

test('Item 7 (soft): a template column the EXAMPLE itself leaves blank is never flagged as incomplete in the response', () => {
  // The template's own example shows column 4 ("Expected Result") is
  // legitimately blank for this kind of row — a response that also leaves
  // it blank must not be penalized for matching the template's own
  // demonstrated pattern.
  const template = {
    header: ['Summary', 'Step #', 'Step Explanation', 'Expected Result'],
    exampleRows: [['Example login test', '1', 'Enter credentials', '']]
  };
  const responseMatchingPattern = 'Summary,Step #,Step Explanation,Expected Result\nLogin,1,Enter valid credentials,\n';
  const result = normalizeTestCaseCsvResponse(responseMatchingPattern, template);
  assert.equal(result.populationNote, '');
});
