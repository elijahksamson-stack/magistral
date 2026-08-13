// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import SubNodeDetail from '../SubNodeDetail';

describe('isolated subnode detail', () => {
  it('shows only the child name and description', () => {
    render(
      <SubNodeDetail
        label="Power demand"
        description="Grid availability constrains deployment."
        onClose={vi.fn()}
      />,
    );

    const panel = screen.getByRole('complementary', { name: /power demand subnode details/i });
    expect(panel).toHaveTextContent('Power demand');
    expect(panel).toHaveTextContent('Grid availability constrains deployment.');
    expect(panel).not.toHaveTextContent(/parent|connection|write.*cell/i);
  });

  it('closes from the visible button', async () => {
    const onClose = vi.fn();
    render(<SubNodeDetail label="Power demand" onClose={onClose} />);

    await userEvent.setup().click(screen.getByRole('button', { name: /close/i }));
    expect(onClose).toHaveBeenCalledOnce();
  });
});
