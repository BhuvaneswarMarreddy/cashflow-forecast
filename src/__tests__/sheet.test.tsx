import React from 'react';
import { render, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import Sheet from '@/components/Sheet';

// jsdom has no <dialog> methods — polyfill enough to observe open/close syncing.
beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
    this.removeAttribute('open');
  };
});

const noop = () => {};

describe('Sheet', () => {
  it('renders children and opens the native dialog when open', () => {
    const { getByText, container } = render(
      <Sheet open onClose={noop} ariaLabel="Test sheet">
        <p>hello</p>
      </Sheet>
    );
    expect(getByText('hello')).toBeInTheDocument();
    expect(container.querySelector('dialog')).toHaveAttribute('open');
  });

  it('fires onClose on cancel (Esc) and on backdrop click, not on content click', () => {
    const onClose = jest.fn();
    const { container, getByText } = render(
      <Sheet open onClose={onClose} ariaLabel="Test sheet">
        <p>content</p>
      </Sheet>
    );
    const dialog = container.querySelector('dialog')!;
    fireEvent(dialog, new Event('cancel', { bubbles: true, cancelable: true }));
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(getByText('content')); // inner content — must NOT close
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(dialog); // the dialog surface itself = backdrop
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('locks the body while open and restores scroll state on close', () => {
    const scrollTo = jest.spyOn(window, 'scrollTo').mockImplementation(noop);
    const { rerender } = render(
      <Sheet open onClose={noop} ariaLabel="Test sheet"><p>x</p></Sheet>
    );
    expect(document.body.style.position).toBe('fixed');
    expect(document.body.style.width).toBe('100%');
    rerender(<Sheet open={false} onClose={noop} ariaLabel="Test sheet"><p>x</p></Sheet>);
    expect(document.body.style.position).toBe('');
    expect(scrollTo).toHaveBeenCalled();
    scrollTo.mockRestore();
  });

  it('applies the maxWidth CSS variable and content className', () => {
    const { container } = render(
      <Sheet open onClose={noop} ariaLabel="Wide" maxWidth="48rem" className="p-8">
        <p>x</p>
      </Sheet>
    );
    const dialog = container.querySelector('dialog')!;
    expect(dialog.getAttribute('style')).toContain('--sheet-max-w: 48rem');
    expect(dialog.firstElementChild).toHaveClass('p-8');
  });
});
