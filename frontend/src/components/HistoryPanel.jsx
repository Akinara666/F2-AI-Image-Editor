import React from 'react';

const HistoryPanel = ({ history, onSelect }) => {
    return (
        <div className="panel history-panel" style={{
            width: '18rem',
            minWidth: '200px',
            borderLeft: '1px solid var(--border)',
            borderRight: 'none',
            animation: 'slideInRight 0.3s ease'
        }}>
            {/* Fixed Header */}
            <div style={{
                padding: 'var(--spacing-md)',
                borderBottom: '1px solid var(--border)',
                background: 'var(--bg-panel)',
                zIndex: 10,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between'
            }}>
                <h3 style={{ margin: 0, fontSize: '1rem', color: 'var(--primary)' }}>
                    History
                </h3>
                <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)', background: 'var(--bg-dark)', padding: '2px 8px', borderRadius: '10px' }}>
                    {history.length}
                </span>
            </div>

            {/* Scrollable List */}
            <div className="custom-scrollbar" style={{
                flex: 1,
                overflowY: 'auto',
                padding: 'var(--spacing-md)',
                display: 'flex',
                flexDirection: 'column',
                gap: 'var(--spacing-md)'
            }}>
                {history.length === 0 && (
                    <div style={{
                        color: 'var(--text-muted)',
                        fontSize: '0.9rem',
                        textAlign: 'center',
                        marginTop: '2rem',
                        opacity: 0.7
                    }}>
                        No generations yet.<br />Time to create!
                    </div>
                )}

                {history.map((item, index) => (
                    <div
                        key={item.id}
                        onClick={() => onSelect(item)}
                        style={{
                            cursor: 'pointer',
                            background: 'var(--bg-dark)',
                            borderRadius: 'var(--radius-md)',
                            overflow: 'hidden',
                            border: '1px solid var(--border)',
                            transition: 'all var(--trans-fast)',
                            flexShrink: 0,
                            animation: `fadeIn 0.3s ease ${index * 0.05}s backwards`
                        }}
                        onMouseEnter={e => {
                            e.currentTarget.style.borderColor = 'var(--primary)';
                            e.currentTarget.style.transform = 'translateY(-2px)';
                            e.currentTarget.style.boxShadow = 'var(--shadow-md)';
                        }}
                        onMouseLeave={e => {
                            e.currentTarget.style.borderColor = 'var(--border)';
                            e.currentTarget.style.transform = 'translateY(0)';
                            e.currentTarget.style.boxShadow = 'none';
                        }}
                    >
                        <div style={{ position: 'relative', width: '100%', paddingTop: '100%' }}>
                            <img
                                src={item.url}
                                alt={item.meta.prompt}
                                loading="lazy"
                                style={{
                                    position: 'absolute',
                                    top: 0,
                                    left: 0,
                                    width: '100%',
                                    height: '100%',
                                    objectFit: 'cover',
                                    transition: 'transform 0.5s ease'
                                }}
                            />
                        </div>
                        <div style={{ padding: 'var(--spacing-sm)' }}>
                            <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: '4px' }}>
                                Seed: {item.meta.seed}
                            </div>
                            <div style={{ fontSize: '0.7rem', color: 'var(--text-main)', opacity: 0.8 }}>
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
