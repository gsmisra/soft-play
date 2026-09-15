import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { validateFeatureFileStructure } from '../../src/bdd/gherkinStructuralValidator';

const VALID_FEATURE = 'Feature: Login\n\nScenario: Successful login\n  Given a user\n  When they log in\n  Then they see the dashboard\n';

test('a normal, well-formed feature file passes', () => {
  const result = validateFeatureFileStructure(VALID_FEATURE);
  assert.equal(result.ok, true);
  assert.equal(result.normalized, VALID_FEATURE.trim());
});

test('F09 reproduction: an unterminated doc string is rejected — the underlying lenient parser alone accepts this', () => {
  const unterminated = 'Feature: Login\nScenario: test\nGiven a user\n"""\nunterminated\n';
  const result = validateFeatureFileStructure(unterminated);
  assert.equal(result.ok, false);
  assert.match(result.reason ?? '', /never closed/);
});

test('a properly terminated doc string is accepted', () => {
  const terminated = 'Feature: Login\nScenario: test\nGiven a user\n"""\nsome text\n"""\nWhen they log in\n';
  const result = validateFeatureFileStructure(terminated);
  assert.equal(result.ok, true);
});

test('F09: a mismatched Examples table (a row with a different cell count than its own header) is rejected', () => {
  const mismatched =
    'Feature: Login\nScenario Outline: try <user>\nGiven a user named <user>\nExamples:\n  | user  | password |\n  | alice | secret   |\n  | bob   |\n';
  const result = validateFeatureFileStructure(mismatched);
  assert.equal(result.ok, false);
  assert.match(result.reason ?? '', /Examples: table/);
});

test('a well-formed Examples table is accepted', () => {
  const wellFormed =
    'Feature: Login\nScenario Outline: try <user>\nGiven a user named <user>\nExamples:\n  | user  | password |\n  | alice | secret   |\n  | bob   | hunter2  |\n';
  const result = validateFeatureFileStructure(wellFormed);
  assert.equal(result.ok, true);
});

test('a single outer Markdown fence around an otherwise-valid feature is stripped, not rejected', () => {
  const fenced = '```gherkin\n' + VALID_FEATURE.trim() + '\n```';
  const result = validateFeatureFileStructure(fenced);
  assert.equal(result.ok, true);
  assert.equal(result.normalized, VALID_FEATURE.trim());
  assert.ok(!result.normalized.includes('```'), 'the fence itself must not end up in the saved content');
});

test('no Scenario/Scenario Outline block at all is still rejected (Item 5\'s original check, kept)', () => {
  const result = validateFeatureFileStructure('Sorry, here is a summary instead of a feature file.');
  assert.equal(result.ok, false);
  assert.match(result.reason ?? '', /No parseable Scenario/);
});
