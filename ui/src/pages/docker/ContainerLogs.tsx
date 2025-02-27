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
  logsType: 'container' | 'compose';
  resourceId: string;    // containerId OR composeProject
  resourceName: string;  // containerName OR projectName
  onClose: () => void;
}

const client = createDockerDesktopClient();

function useDockerDesktopClient() {
  return client;
}

/**
 * Pattern-based log highlighting
 * Recognizes levels (INFO, WARN, ERROR), HTTP methods/status,
 * as well as known app messages (Spring, NATS, etc.),
 * and timestamps with fractional seconds + optional trailing 'Z'.
 */
function colorizeLog(line: string): string {
  const patterns: { regex: RegExp; className: string }[] = [
    // Common log levels
    { regex: /\b(INFO|DEBUG|TRACE)\b/, className: 'log-info' },
    { regex: /\b(WARN)\b/, className: 'log-warn' },
    { regex: /\b(ERROR|FATAL|CRITICAL)\b/, className: 'log-error' },

    // HTTP methods/statuses
    { regex: /\b(HTTP\/\d\.\d|\bGET\b|\bPOST\b|\bPUT\b|\bDELETE\b)\b/, className: 'log-http' },
    {
      regex: /\b(200 OK|301 Moved|302 Found|400 Bad Request|403 Forbidden|404 Not Found|500 Internal Server Error)\b/,
      className: 'log-http-status'
    },

    // NATS
    { regex: /\b(NATS Connected|NATS Disconnected|NATS Error)\b/, className: 'log-nats' },

    // Spring Boot / Hibernate
    { regex: /\b(Spring Boot started|Spring Context Loaded|Hibernate Initialized)\b/, className: 'log-spring' },

    // Nginx
    { regex: /\b(nginx error|nginx started|nginx stopped)\b/, className: 'log-nginx' },

    // DB / Connection
    { regex: /\b(connection refused|database error|timeout)\b/, className: 'log-db' },

    // Timestamps (supports fractional seconds and optional trailing 'Z')
    { regex: /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z?/, className: 'log-timestamp' },
  ];

  patterns.forEach(({ regex, className }) => {
    line = line.replace(regex, (match) => `<span class="${className}">${match}</span>`);
  });
  return line;
}

const ContainerLogs: React.FC<ContainerLogsProps> = ({
                                                       activeEnvironment,
                                                       logsType,
                                                       resourceId,
                                                       resourceName,
                                                       onClose,
                                                     }) => {
  const ddClient = useDockerDesktopClient();

  // State
  const [logs, setLogs] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [autoScroll, setAutoScroll] = useState(true);
  const [timestamps] = useState(true);

  const [tailLines, setTailLines] = useState(500);
  const [tempTailLines, setTempTailLines] = useState(tailLines);

  // Font size
  const [logFontSize, setLogFontSize] = useState<number>(0.75);

  // Refs
  const logsEndRef = useRef<HTMLDivElement>(null);
  const logsContainerRef = useRef<HTMLDivElement>(null);

  const POLL_INTERVAL_MS = 1000;
  const pollTimer = useRef<NodeJS.Timeout | null>(null);

  // Auto-scroll to bottom if enabled
  const scrollToBottom = () => {
    if (logsEndRef.current) {
      logsEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  };

  // Check if user scrolled away from bottom to toggle autoScroll
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

  // Setup log polling
  useEffect(() => {
    // Clear any existing timer
    if (pollTimer.current) {
      clearInterval(pollTimer.current);
      pollTimer.current = null;
    }

    setLogs([]);
    setError('');
    setIsLoading(true);

    if (!activeEnvironment || !resourceId) {
      setError('No environment or container selected');
      setIsLoading(false);
      return;
    }

    let isMounted = true; // Prevent running after unmount

    const pollLogs = async () => {
      await fetchLogs(false); // Step 1: Fetch logs and wait for it to finish
      if (isMounted) {
        pollTimer.current = setTimeout(pollLogs, POLL_INTERVAL_MS); // Step 2: Wait for interval before fetching again
      }
    };

    // Start the first fetch, then begin polling
    fetchLogs().then(() => {
      if (isMounted) {
        // Then set up repeated polling
        pollLogs();
      }
    });

    return () => {
      // Stop further execution if the component unmounts
      isMounted = false;
      if (pollTimer.current) {
        clearTimeout(pollTimer.current);
        pollTimer.current = null;
      }
    };
  }, [activeEnvironment, resourceId, timestamps]);

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

      // Decide which endpoint to call
      let endpoint = '';
      let payload: any = {
        hostname: activeEnvironment.hostname,
        username: activeEnvironment.username
      };

      if (logsType === 'container') {
        endpoint = '/container/logs';
        payload.containerId = resourceId;
        payload.tail = tailLines;
        // For containers, maybe we also have "timestamps: true/false"
        payload.timestamps = true;
      } else {
        // Compose logs
        endpoint = '/compose/logs';
        payload.composeProject = resourceId;
        // If you want to allow tail lines for compose, do so:
        payload.tail = tailLines;
      }

      const response = (await ddClient.extension.vm.service.post(endpoint, payload)) as ContainerLogsResponse;

      if (response && typeof response === 'object' && 'error' in response) {
        // If the response shape includes an error field
        const errorResponse = response as ErrorResponse;
        throw new Error(errorResponse.error);
      }

      // If no error, update logs
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

  // Merge newly fetched lines with existing lines
  // to avoid duplicates and partial refreshes
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

  const handleKeyDownForInput = (e: any) => {
    if (e.key === 'Enter') {
      // triggers handleBlur
      e.target.blur();
    }
  };

  const handleBlurForInput = () => {
    // On blur, validate and update the "final" state.
    let numericValue = Number(tempTailLines);
    if (isNaN(numericValue) || numericValue < 500) {
      numericValue = 500; // enforce minimum
    }
    if (numericValue > 5000) {
      numericValue = 5000; // enforce maximum
    }
    setTailLines(numericValue);
    setTempTailLines(numericValue);
  };

  const handleChangeForInput = (e: any) => {
    // Keep track of user input in local state.
    setTempTailLines(e.target.value);
  };

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
        <Typography sx={{ fontSize: '1rem' }}>
          {resourceName} ({resourceId.substring(0, 12)})
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
            value={tempTailLines}
            onChange={handleChangeForInput}
            onBlur={handleBlurForInput}
            onKeyDown={handleKeyDownForInput}
            size="small"
            InputProps={{
              inputProps: { min: 500 },
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

          {/* Reload button */}
          <Tooltip title="Reload logs">
            <IconButton onClick={handleReload} disabled={isLoading} size="small">
              <RefreshIcon fontSize="small" />
            </IconButton>
          </Tooltip>

          {/* Close button */}
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
          fontSize: `${logFontSize}rem`,
          position: 'relative',
          '& .log-info': { color: '#0dbc79' },
          '& .log-warn': { color: '#e5e510' },
          '& .log-error': { color: '#f14c4c' },
          '& .log-http': { color: '#2472c8' },
          '& .log-http-status': { color: '#bc3fbc' },
          '& .log-nats': { color: '#11a8cd' },
          '& .log-spring': { color: '#d670d6' },
          '& .log-nginx': { color: '#f5f543' },
          '& .log-db': { color: '#cd3131' },
          '& .log-timestamp': { color: '#666666' },
        }}
        ref={logsContainerRef}
        onScroll={handleScroll}
      >
        {/* Loading indicator if no logs yet */}
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
