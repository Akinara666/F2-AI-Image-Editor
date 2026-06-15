import { createContext, useContext, useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { createClientId } from '../constants';
import './ToastProvider.css';

const ToastContext = createContext(null);
const TOAST_DURATION_MS = 5000;

export const useToast = () => {
    const context = useContext(ToastContext);
    if (!context) {
        throw new Error('useToast must be used within a ToastProvider');
    }
    return context;
};

export const ToastProvider = ({ children }) => {
    const [toasts, setToasts] = useState([]);
    const timersRef = useRef(new Map());

    const clearToastTimer = useCallback((id) => {
        const timerId = timersRef.current.get(id);
        if (timerId) {
            window.clearTimeout(timerId);
            timersRef.current.delete(id);
        }
    }, []);

    const removeToast = useCallback((id) => {
        clearToastTimer(id);
        setToasts(prev => prev.filter(t => t.id !== id));
    }, [clearToastTimer]);

    const addToast = useCallback((message, type = 'info') => {
        const id = createClientId('toast');
        setToasts(prev => [...prev, { id, message, type }]);

        const timerId = window.setTimeout(() => {
            removeToast(id);
        }, TOAST_DURATION_MS);
        timersRef.current.set(id, timerId);
    }, [removeToast]);

    useEffect(() => () => {
        timersRef.current.forEach((timerId) => {
            window.clearTimeout(timerId);
        });
        timersRef.current.clear();
    }, []);

    // Стабильные идентичности: иначе каждый тост ре-рендерит провайдер, меняет
    // ссылки showError/… и перезапускает у потребителей эффекты на них (напр.
    // загрузку моделей) — вплоть до бесконечного цикла запрос→ошибка→тост.
    const showSuccess = useCallback((msg) => addToast(msg, 'success'), [addToast]);
    const showError = useCallback((msg) => addToast(msg, 'error'), [addToast]);
    const showInfo = useCallback((msg) => addToast(msg, 'info'), [addToast]);
    const contextValue = useMemo(
        () => ({ showSuccess, showError, showInfo }),
        [showSuccess, showError, showInfo]
    );

    return (
        <ToastContext.Provider value={contextValue}>
            {children}
            <div className="toast-container" aria-live="polite" aria-label="Уведомления">
                {toasts.map(toast => (
                    <div
                        key={toast.id}
                        className={`toast toast--${toast.type}`}
                        role={toast.type === 'error' ? 'alert' : 'status'}
                    >
                        <span className="toast__message">{toast.message}</span>
                        <button
                            className="toast__close"
                            onClick={() => removeToast(toast.id)}
                            aria-label="Закрыть уведомление"
                        >
                            ✕
                        </button>
                        <div className="toast__progress" />
                    </div>
                ))}
            </div>
        </ToastContext.Provider>
    );
};
