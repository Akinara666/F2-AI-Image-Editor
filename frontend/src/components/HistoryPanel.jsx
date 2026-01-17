import React from 'react';

const HistoryPanel = ({ history, onSelect }) => {
    return (
        <div style={{
            width: '250px',
            background: '#2b2b2b',
            color: '#eee',
            padding: '10px',
            display: 'flex',
            flexDirection: 'column',
            gap: '10px',
            borderLeft: '1px solid #444',
            overflowY: 'auto',
            height: '100%'
        }}>
            <h3 style={{ margin: '0 0 10px 0', fontSize: '16px', borderBottom: '1px solid #444', paddingBottom: '5px' }}>
                History ({history.length})
            </h3>

            {history.length === 0 && (
                <div style={{ color: '#666', fontSize: '13px', textAlign: 'center', marginTop: '20px' }}>
                    No generations yet.
                </div>
            )}

            {history.map((item) => (
                <div
                    key={item.id}
                    onClick={() => onSelect(item)}
                    style={{
                        cursor: 'pointer',
                        background: '#1e1e1e',
                        borderRadius: '6px',
                        overflow: 'hidden',
                        border: '1px solid #444',
                        transition: 'border-color 0.2s'
                    }}
                    onMouseEnter={e => e.currentTarget.style.borderColor = '#00d4ff'}
                    onMouseLeave={e => e.currentTarget.style.borderColor = '#444'}
                >
                    <div style={{ position: 'relative', width: '100%', paddingTop: '100%' }}>
                        <img
                            src={item.url}
                            alt={item.meta.prompt}
                            style={{
                                position: 'absolute',
                                top: 0,
                                left: 0,
                                width: '100%',
                                height: '100%',
                                objectFit: 'cover'
                            }}
                        />
                    </div>
                    <div style={{ padding: '8px' }}>
                        <div style={{ fontSize: '11px', color: '#aaa', marginBottom: '4px' }}>
                            Seed: {item.meta.seed}
                        </div>
                        <div style={{ fontSize: '10px', color: '#666', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                            {new Date(item.timestamp).toLocaleTimeString()}
                        </div>
                    </div>
                </div>
            ))}
        </div>
    );
};

export default HistoryPanel;
