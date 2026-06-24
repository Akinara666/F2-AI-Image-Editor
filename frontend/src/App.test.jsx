import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import App from './App';
import {
  APP_SETTINGS_STORAGE_KEY,
  APP_SETTINGS_STORAGE_VERSION,
  DEFAULT_BRUSH_SETTINGS,
  DEFAULT_PARAMS
} from './utils/appState';

const toastApi = {
  showSuccess: vi.fn(),
  showError: vi.fn(),
  showInfo: vi.fn()
};

vi.mock('axios');
vi.mock('./components/ToastProvider', () => ({
  useToast: () => toastApi
}));
vi.mock('./components/Editor', () => ({
  default: React.forwardRef(function EditorMock(_, ref) {
    React.useImperativeHandle(ref, () => ({
      undo: vi.fn(),
      clearAll: vi.fn()
    }));
    return <div data-testid="editor-mock" />;
  })
}));
vi.mock('./components/HistoryPanel', () => ({
  default: ({ history = [] }) => <div data-testid="history-mock">{history.length}</div>
}));
vi.mock('./components/Sidebar', () => ({
  default: ({ availableModels, params }) => (
    <div data-testid="sidebar-mock">
      <div data-testid="models-count">{availableModels.length}</div>
      <div data-testid="current-model-id">{params.model_id}</div>
    </div>
  )
}));

describe('App', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
  });

  it('загружает модели и заменяет недоступную модель на первую доступную', async () => {
    localStorage.setItem(APP_SETTINGS_STORAGE_KEY, JSON.stringify({
      version: APP_SETTINGS_STORAGE_VERSION,
      params: {
        ...DEFAULT_PARAMS,
        model_id: 'missing-model'
      },
      brush: DEFAULT_BRUSH_SETTINGS
    }));

    axios.get.mockResolvedValue({
      data: {
        models: [
          { id: 'model-alpha', label: 'Model Alpha' },
          { id: 'model-beta', label: 'Model Beta' }
        ]
      }
    });

    render(<App />);

    await waitFor(() => {
      expect(screen.getByTestId('models-count')).toHaveTextContent('2');
      expect(screen.getByTestId('current-model-id')).toHaveTextContent('model-alpha');
    });
  });

  it('сохраняет выбранную модель, если она есть в ответе backend', async () => {
    localStorage.setItem(APP_SETTINGS_STORAGE_KEY, JSON.stringify({
      version: APP_SETTINGS_STORAGE_VERSION,
      params: {
        ...DEFAULT_PARAMS,
        model_id: 'model-beta'
      },
      brush: DEFAULT_BRUSH_SETTINGS
    }));

    axios.get.mockResolvedValue({
      data: {
        models: [
          { id: 'model-alpha', label: 'Model Alpha' },
          { id: 'model-beta', label: 'Model Beta' }
        ]
      }
    });

    render(<App />);

    await waitFor(() => {
      expect(screen.getByTestId('current-model-id')).toHaveTextContent('model-beta');
    });
  });

  it('показывает toast-ошибку, если список моделей не загрузился', async () => {
    axios.get.mockRejectedValue(new Error('network failed'));

    render(<App />);

    await waitFor(() => {
      expect(toastApi.showError).toHaveBeenCalledWith('Не удалось загрузить список моделей с сервера.');
    });
  });
});
