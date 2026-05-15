import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider, useToast } from './ToastProvider';

const ToastTrigger = () => {
  const { showSuccess, showError } = useToast();

  return (
    <>
      <button type="button" onClick={() => showSuccess('Успех')}>
        success
      </button>
      <button type="button" onClick={() => showError('Ошибка')}>
        error
      </button>
    </>
  );
};

describe('ToastProvider', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('показывает toast и закрывает его вручную', () => {
    render(
      <ToastProvider>
        <ToastTrigger />
      </ToastProvider>
    );

    fireEvent.click(screen.getByText('success'));
    expect(screen.getByText('Успех')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '✕' }));
    expect(screen.queryByText('Успех')).not.toBeInTheDocument();
  });

  it('автоматически удаляет toast по таймеру', () => {
    render(
      <ToastProvider>
        <ToastTrigger />
      </ToastProvider>
    );

    fireEvent.click(screen.getByText('error'));
    expect(screen.getByText('Ошибка')).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(5000);
    });

    expect(screen.queryByText('Ошибка')).not.toBeInTheDocument();
  });
});
