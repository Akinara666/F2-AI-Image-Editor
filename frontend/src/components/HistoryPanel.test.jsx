import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import HistoryPanel from './HistoryPanel';

const historyItem = {
  id: 'history-1',
  url: '/history/item.png',
  timestamp: 1710000000000,
  meta: {
    prompt: 'Очень длинный промпт для проверки усечения строки в карточке истории',
    seed: 42
  }
};

describe('HistoryPanel', () => {
  it('показывает пустое состояние, если истории нет', () => {
    const { container } = render(<HistoryPanel history={[]} onSelect={vi.fn()} />);

    expect(container.querySelector('.history-panel__empty')).toHaveTextContent('Самое время создать первую.');
  });

  it('вызывает onSelect по клику на карточку, когда панель не занята', () => {
    const onSelect = vi.fn();
    render(<HistoryPanel history={[historyItem]} onSelect={onSelect} />);

    fireEvent.click(screen.getByText(/Сид:/));

    expect(onSelect).toHaveBeenCalledWith(historyItem);
  });

  it('не даёт выбрать карточку, когда панель занята', () => {
    const onSelect = vi.fn();
    render(<HistoryPanel history={[historyItem]} onSelect={onSelect} isBusy />);

    fireEvent.click(screen.getByText(/Сид:/));

    expect(onSelect).not.toHaveBeenCalled();
  });

  it('открывает меню и прокидывает действия наружу', () => {
    const onCopyPrompt = vi.fn();
    const onDownload = vi.fn();
    const onDelete = vi.fn();

    render(
      <HistoryPanel
        history={[historyItem]}
        onSelect={vi.fn()}
        onCopyPrompt={onCopyPrompt}
        onDownload={onDownload}
        onDelete={onDelete}
      />
    );

    fireEvent.click(screen.getByLabelText('Действия с элементом истории'));
    fireEvent.click(screen.getByText('Копировать промпт'));
    expect(onCopyPrompt).toHaveBeenCalledWith(historyItem);

    fireEvent.click(screen.getByLabelText('Действия с элементом истории'));
    fireEvent.click(screen.getByText('Скачать'));
    expect(onDownload).toHaveBeenCalledWith(historyItem);

    fireEvent.click(screen.getByLabelText('Действия с элементом истории'));
    fireEvent.click(screen.getByText('Удалить'));
    expect(onDelete).toHaveBeenCalledWith(historyItem);
  });

  it('сообщает наружу о пропавшем элементе истории', () => {
    const onMissing = vi.fn();
    render(<HistoryPanel history={[historyItem]} onSelect={vi.fn()} onMissing={onMissing} />);

    fireEvent.error(screen.getByRole('img'));

    expect(onMissing).toHaveBeenCalledWith(historyItem);
  });
});
