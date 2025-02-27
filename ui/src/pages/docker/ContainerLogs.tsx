import React, { useState, useEffect, useRef } from 'react';
import { createDockerDesktopClient } from '@docker/extension-api-client';
import {
  Box,
  Paper,
  Typography,
  IconButton,
  Tooltip,
  CircularProgress,
  FormControlLabel,
  Switch,
  TextField,
  Alert,
} from '@mui/material';
import VerticalAlignBottomIcon from '@mui/icons-material/VerticalAlignBottom';
import CloseIcon from '@mui/icons-material/Close';
import RefreshIcon from '@mui/icons-material/Refresh';
import AddIcon from '@mui/icons-material/Add';
import RemoveIcon from '@mui/icons-material/Remove';
import { Environment } from '../../App';

interface ErrorResponse {
  error: string;
  output?: string;
}

interface ContainerLogsResponse {
  success?: boolean;
  logs: string[];
}

interface ContainerLogsProps {
  activeEnvironment?: Environment;
  containerId: string;
  containerName: string;
  onClose: () => void;
}

const client = createDockerDesktopClient();

function useDockerDesktopClient() {
  return client;
}

// ANSI color codes -> CSS classes
const ansiToColorClass: Record<string, string> = {
  '30': 'log-black',
  '31': 'log-red',
  '32': 'log-green',
  '33': 'log-yellow',
  '34': 'log-blue',
  '35': 'log-magenta',
  '36': 'log-cyan',
  '37': 'log-white',
  '90': 'log-gray',
  '91': 'log-bright-red',
  '92': 'log-bright-green',
  '93': 'log-bright-yellow',
  '94': 'log-bright-blue',
  '95': 'log-bright-magenta',
  '96': 'log-bright-cyan',
  '97': 'log-bright-white',
};

function colorizeLog(line: string): string {
  // Basic ANSI color code regex: \u001b\[(3[0-7]|9[0-7])m
  const colorCodeRegex = /\u001b\[(3[0-7]|9[0-7])m(.*?)(\u001b\[0m|\u001b\[39m)/g;
  return line.replace(colorCodeRegex, (_match, colorCode, text) => {
    const className = ansiToColorClass[colorCode] || '';
    return `<span class="${className}">${text}</span>`;
  });
}

const ContainerLogs: React.FC<ContainerLogsProps> = ({
                                                       activeEnvironment,
                                                       containerId,
                                                       containerName,
                                                       onClose,
                                                     }) => {
  const ddClient = useDockerDesktopClient();

  // State
  const [logs, setLogs] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [autoScroll, setAutoScroll] = useState(true);

  // Existing toggles
  const [follow, setFollow] = useState(true);
  const [tailLines, setTailLines] = useState(100);
  const [timestamps] = useState(true);

  // New state for font size
  const [logFontSize, setLogFontSize] = useState<number>(0.75);

  // Refs
  const logsEndRef = useRef<HTMLDivElement>(null);
  const logsContainerRef = useRef<HTMLDivElement>(null);

  const POLL_INTERVAL_MS = 1000;
  const pollTimer = useRef<NodeJS.Timeout | null>(null);

  const scrollToBottom = () => {
    if (logsEndRef.current) {
      logsEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  };

  const handleScroll = () => {
    if (!logsContainerRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = logsContainerRef.current;
    const atBottom = scrollHeight - scrollTop - clientHeight < 100;
    if (atBottom !== autoScroll) {
      setAutoScroll(atBottom);
    }
  };

  useEffect(() => {
    if (autoScroll && logs.length > 0) {
      scrollToBottom();
    }
  }, [logs, autoScroll]);

  useEffect(() => {
    // Clear any existing timer
    if (pollTimer.current) {
      clearInterval(pollTimer.current);
      pollTimer.current = null;
    }

    setLogs([]);
    setError('');
    setIsLoading(true);

    if (!activeEnvironment || !containerId) {
      setError('No environment or container selected');
      setIsLoading(false);
      return;
    }

    // If user enabled "follow," start polling
    if (follow) {
      // Immediately fetch once
      fetchLogs();
      // Then set up repeated polling
      pollTimer.current = setInterval(() => {
        fetchLogs(false);
      }, POLL_INTERVAL_MS);
    } else {
      // If follow is off, do one fetch
      fetchLogs();
    }

    return () => {
      if (pollTimer.current) {
        clearInterval(pollTimer.current);
      }
    };
  }, [activeEnvironment, containerId, follow, tailLines, timestamps]);

  const handleReload = () => {
    fetchLogs(true);
  };

  const fetchLogs = async (resetLogs = true) => {
    if (!activeEnvironment) {
      setError('No environment selected');
      return;
    }

    try {
      if (resetLogs) {
        setIsLoading(true);
        setLogs([]);
      }

      if (!ddClient.extension?.vm?.service) {
        throw new Error('Docker Desktop service not available');
      }

      const response = (await ddClient.extension.vm.service.post('/container/logs', {
        hostname: activeEnvironment.hostname,
        username: activeEnvironment.username,
        containerId: containerId,
        tail: tailLines,
        timestamps: timestamps,
      })) as ContainerLogsResponse;

      if (response && typeof response === 'object' && 'error' in response) {
        const errorResponse = response as ErrorResponse;
        throw new Error(errorResponse.error);
      }

      setLogs((prev) => {
        if (resetLogs || prev.length === 0) {
          return response.logs;
        }
        return mergeNewLines(prev, response.logs);
      });

      setError('');
      setIsLoading(false);
    } catch (err: any) {
      console.error('Failed to fetch logs:', err);
      setError(err.message || 'Failed to fetch logs');
      setIsLoading(false);
    }
  };

  const mergeNewLines = (oldLines: string[], newLines: string[]): string[] => {
    if (oldLines.length === 0) return newLines;
    const lastOld = oldLines[oldLines.length - 1];
    const idx = newLines.indexOf(lastOld);
    if (idx === -1) {
      return [...oldLines, ...newLines];
    } else if (idx === newLines.length - 1) {
      return oldLines;
    } else {
      const toAppend = newLines.slice(idx + 1);
      return [...oldLines, ...toAppend];
    }
  };

  // Font size increment/decrement
  const increaseFontSize = () => setLogFontSize((prev) => Math.min(prev + 0.1, 2));
  const decreaseFontSize = () => setLogFontSize((prev) => Math.max(prev - 0.1, 0.5));

  return (
    <Box
      sx={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        borderRadius: 1,
        overflow: 'hidden',
        bgcolor: 'background.paper',
      }}
    >
      {/* Header with controls */}
      <Box
        sx={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          p: 1,
          borderBottom: 1,
          borderColor: 'divider',
        }}
      >
        <Typography variant="h6" sx={{ fontSize: '1rem' }}>
          Logs: {containerName} ({containerId.substring(0, 12)})
        </Typography>

        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <span>{autoScroll ? 'Auto-scroll enabled' : 'Auto-scroll disabled'}</span>
          <FormControlLabel
            control={
              <Switch
                checked={autoScroll}
                onChange={(e) => setAutoScroll(e.target.checked)}
                size="small"
              />
            }
            label="Follow"
            sx={{ mr: 0 }}
          />

          {/* Tail lines input */}
          <TextField
            type="number"
            label="Tail lines"
            value={tailLines}
            onChange={(e) => setTailLines(Number(e.target.value))}
            size="small"
            InputProps={{
              inputProps: { min: 1 },
            }}
            sx={{ width: 100 }}
          />

          {/* Font size controls */}
          <Tooltip title="Decrease font size">
            <IconButton onClick={decreaseFontSize} size="small">
              <RemoveIcon fontSize="small" />
            </IconButton>
          </Tooltip>
          <Tooltip title="Increase font size">
            <IconButton onClick={increaseFontSize} size="small">
              <AddIcon fontSize="small" />
            </IconButton>
          </Tooltip>

          <Tooltip title="Reload logs">
            <IconButton onClick={handleReload} disabled={isLoading} size="small">
              <RefreshIcon fontSize="small" />
            </IconButton>
          </Tooltip>

          <Tooltip title="Scroll to bottom">
            <IconButton onClick={scrollToBottom} size="small">
              <VerticalAlignBottomIcon fontSize="small" />
            </IconButton>
          </Tooltip>

          <Tooltip title="Close logs">
            <IconButton onClick={onClose} edge="end" size="small">
              <CloseIcon fontSize="small" />
            </IconButton>
          </Tooltip>
        </Box>
      </Box>

      {/* Error message */}
      {error && (
        <Alert severity="error" sx={{ m: 1 }}>
          {error}
        </Alert>
      )}

      {/* Logs area */}
      <Paper
        elevation={0}
        sx={{
          flexGrow: 1,
          overflow: 'auto',
          bgcolor: '#1e1e1e',
          color: '#d4d4d4',
          p: 1,
          fontFamily: 'monospace',
          // Apply dynamic font size here
          fontSize: `${logFontSize}rem`,
          position: 'relative',
          '& .log-black': { color: '#000000' },
          '& .log-red': { color: '#cd3131' },
          '& .log-green': { color: '#0dbc79' },
          '& .log-yellow': { color: '#e5e510' },
          '& .log-blue': { color: '#2472c8' },
          '& .log-magenta': { color: '#bc3fbc' },
          '& .log-cyan': { color: '#11a8cd' },
          '& .log-white': { color: '#e5e5e5' },
          '& .log-gray': { color: '#666666' },
          '& .log-bright-red': { color: '#f14c4c' },
          '& .log-bright-green': { color: '#23d18b' },
          '& .log-bright-yellow': { color: '#f5f543' },
          '& .log-bright-blue': { color: '#3b8eea' },
          '& .log-bright-magenta': { color: '#d670d6' },
          '& .log-bright-cyan': { color: '#29b8db' },
          '& .log-bright-white': { color: '#ffffff' },
        }}
        ref={logsContainerRef}
        onScroll={handleScroll}
      >
        {isLoading && logs.length === 0 ? (
          <Box
            sx={{
              display: 'flex',
              justifyContent: 'center',
              alignItems: 'center',
              height: '100%',
            }}
          >
            <CircularProgress color="inherit" size={24} />
          </Box>
        ) : logs.length === 0 ? (
          <Box
            sx={{
              display: 'flex',
              justifyContent: 'center',
              alignItems: 'center',
              height: '100%',
              color: 'text.secondary',
            }}
          >
            No logs available
          </Box>
        ) : (
          <>
            {logs.map((line, index) => (
              <Box
                key={index}
                sx={{
                  py: 0.1,
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-all',
                  borderBottom: '1px solid rgba(255,255,255,0.05)',
                }}
                dangerouslySetInnerHTML={{
                  __html: colorizeLog(line),
                }}
              />
            ))}
            <div ref={logsEndRef} />
          </>
        )}
      </Paper>
    </Box>
  );
};

export default ContainerLogs;
