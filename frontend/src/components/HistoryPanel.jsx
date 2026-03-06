import React from 'react';
import './HistoryPanel.css';

const HistoryPanel = ({ history, onSelect }) => {
    return (
        <div className="panel history-panel">
            {/* Fixed Header */}
            <div className="history-panel__header">
                <h3 className="history-panel__title">
                    History
                </h3>
                <span className="history-panel__count">
                    {history.length}
                </span>
            </div>

            {/* Scrollable List */}
            <div className="custom-scrollbar history-panel__list">
                {history.length === 0 && (
                    <div className="history-panel__empty">
                        No generations yet.<br />Time to create!
                    </div>
                )}

                {history.map((item, index) => (
                    <div
                        key={item.id}
                        className="history-panel__card"
                        onClick={() => onSelect(item)}
                        style={{ animationDelay: `${index * 0.05}s`, animation: `fadeIn 0.3s ease ${index * 0.05}s backwards` }}
                    >
                        <div className="history-panel__thumb">
                            <img
                                src={item.url}
                                alt={item.meta.prompt}
                                loading="lazy"
                            />
                        </div>
                        <div className="history-panel__meta">
                            <div className="history-panel__seed">
                                Seed: {item.meta.seed}
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
