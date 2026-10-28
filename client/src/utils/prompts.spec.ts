import { detectVariables, extractVariableInfo } from './prompts';

it.each(['current_user', 'current_date', 'iso_datetime', 'current_datetime', 'current_model'])(
  'recognises %s as automatic context without a user-input dialog',
  (variable) => {
    expect(detectVariables(`Hello {{ ${variable.toUpperCase()} }}.`)).toBe(false);
  },
);

it('requests only interactive variables in mixed context prompts', () => {
  const text = '{{current_model}} {{topic}} {{ CURRENT_USER }} {{topic}} {{tone:formal|casual}}';
  expect({ hasInputs: detectVariables(text), fields: extractVariableInfo(text) }).toStrictEqual({
    hasInputs: true,
    fields: {
      allVariables: ['topic', 'topic', 'tone:formal|casual'],
      uniqueVariables: ['topic', 'tone:formal|casual'],
      repeatedVariables: new Set(['topic']),
      variableIndexMap: new Map([
        ['topic', 0],
        ['tone:formal|casual', 1],
      ]),
    },
  });
});
