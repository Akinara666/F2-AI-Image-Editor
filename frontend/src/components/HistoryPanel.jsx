import { useEffect, useRef, useState } from 'react';
import { resolveApiUrl } from '../constants';
import './HistoryPanel.css';

const HistoryPanel = ({
    history,
    onSelect,
    onMissing,
    onDelete,
    onDownload,
    onCopyPrompt,
    isBusy = false
}) => {
    const [openMenuId, setOpenMenuId] = useState(null);
    const rootRef = useRef(null);

    useEffect(() => {
        const handlePointerDown = (event) => {
            if (!rootRef.current?.contains(event.target)) {
                setOpenMenuId(null);
            }
        };

        document.addEventListener('pointerdown', handlePointerDown);
        return () => {
            document.removeEventListener('pointerdown', handlePointerDown);
        };
    }, []);

    return (
        <div className="panel history-panel" ref={rootRef}>
            {/* Закреплённый заголовок. */}
            <div className="history-panel__header">
                <h3 className="history-panel__title">
                    История
                </h3>
                <span className="history-panel__count">
                    {history.length}
                </span>
            </div>

            {/* Прокручиваемый список. */}
            <div className="custom-scrollbar history-panel__list">
                {history.length === 0 && (
                    <div className="history-panel__empty">
                        Пока нет генераций.<br />Самое время создать первую.
                    </div>
                )}

                {history.map((item, index) => (
                    <div
                        key={item.id}
                        className={`history-panel__card ${isBusy ? 'history-panel__card--disabled' : ''}`}
                        role="button"
                        tabIndex={isBusy ? -1 : 0}
                        aria-label={`Восстановить на холст: ${item.meta?.prompt || `сид ${item.meta?.seed}`}`}
                        onClick={() => {
                            if (!isBusy) {
                                void onSelect(item);
                            }
                        }}
                        onKeyDown={(event) => {
                            if (isBusy || (event.key !== 'Enter' && event.key !== ' ')) {
                                return;
                            }
                            event.preventDefault();
                            void onSelect(item);
                        }}
                        aria-disabled={isBusy}
                        style={{ animationDelay: `${index * 0.05}s`, animation: `fadeIn 0.3s ease ${index * 0.05}s backwards` }}
                    >
                        <div className="history-panel__thumb">
                            <button
                                type="button"
                                className="history-panel__menu-trigger"
                                onClick={(event) => {
                                    event.stopPropagation();
                                    setOpenMenuId((currentId) => (
                                        currentId === item.id ? null : item.id
                                    ));
                                }}
                                aria-label="Действия с элементом истории"
                                aria-expanded={openMenuId === item.id}
                            >
                                ⋯
                            </button>
                            {openMenuId === item.id && (
                                <div
                                    className="history-panel__menu"
                                    onClick={(event) => {
                                        event.stopPropagation();
                                    }}
                                >
                                    <button
                                        type="button"
                                        className="history-panel__menu-item"
                                        onClick={() => {
                                            setOpenMenuId(null);
                                            if (onCopyPrompt) {
                                                void onCopyPrompt(item);
                                            }
                                        }}
                                    >
                                        Копировать промпт
                                    </button>
                                    <button
                                        type="button"
                                        className="history-panel__menu-item"
                                        onClick={() => {
                                            setOpenMenuId(null);
                                            if (onDownload) {
                                                void onDownload(item);
                                            }
                                        }}
                                    >
                                        Скачать
                                    </button>
                                    <button
                                        type="button"
                                        className="history-panel__menu-item history-panel__menu-item--danger"
                                        onClick={() => {
                                            setOpenMenuId(null);
                                            if (onDelete) {
                                                void onDelete(item);
                                            }
                                        }}
                                    >
                                        Удалить
                                    </button>
                                </div>
                            )}
                            <img
                                src={resolveApiUrl(item.url)}
                                alt={item.meta.prompt}
                                loading="lazy"
                                crossOrigin="anonymous"
                                onError={() => {
                                    if (onMissing) {
                                        onMissing(item);
                                    }
                                }}
                            />
                        </div>
                        <div className="history-panel__meta">
                            <div className="history-panel__seed">
                                Сид: {item.meta.seed}
                            </div>
                            {item.meta.prompt && (
                                <div className="history-panel__prompt">
                                    {item.meta.prompt.length > 40 ? item.meta.prompt.slice(0, 40) + '…' : item.meta.prompt}
                                </div>
                            )}
                            <div className="history-panel__time">
                                {new Date(item.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                            </div>
                        </div>
                    </div>
                ))}
            </div>
        </div>
    );
};

export default HistoryPanel;
