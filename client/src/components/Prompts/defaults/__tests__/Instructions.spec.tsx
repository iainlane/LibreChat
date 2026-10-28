import React, { useState } from 'react';
import type { ChatInstructions } from 'librechat-data-provider';
import { render, screen, fireEvent } from 'test/layout-test-utils';
import Instructions from '../Instructions';

function setup(initial?: ChatInstructions, legacyText?: string) {
  function Fixture() {
    const [instructions, setInstructions] = useState(initial);
    return (
      <>
        <Instructions
          instructions={instructions}
          legacyText={legacyText}
          onChange={setInstructions}
        />
        <output data-testid="selection">{JSON.stringify(instructions)}</output>
      </>
    );
  }
  return render(<Fixture />);
}

it('starts with the default and persists explicit opt-out and custom text', () => {
  setup();
  expect(screen.getByRole('radio', { name: 'Use default instructions' })).toBeChecked();
  fireEvent.click(screen.getByRole('radio', { name: 'No instructions' }));
  expect(screen.getByTestId('selection')).toHaveTextContent('{"mode":"none"}');
  fireEvent.click(screen.getByRole('radio', { name: 'Custom instructions' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'Custom instructions' }), {
    target: { value: 'Use short examples.' },
  });
  expect(screen.getByTestId('selection')).toHaveTextContent(
    '{"mode":"custom","text":"Use short examples."}',
  );
  fireEvent.click(screen.getByRole('radio', { name: 'Use default instructions' }));
  expect(screen.getByTestId('selection')).toHaveTextContent('{"mode":"inherit"}');
});

it('shows legacy instructions as custom and honours an explicit inherited selection', () => {
  const { unmount } = setup(undefined, 'An existing prompt');
  expect(screen.getByRole('radio', { name: 'Custom instructions' })).toBeChecked();
  expect(screen.getByRole('textbox')).toHaveValue('An existing prompt');
  unmount();
  setup({ mode: 'inherit' }, 'An existing prompt');
  expect(screen.getByRole('radio', { name: 'Use default instructions' })).toBeChecked();
  expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
});
