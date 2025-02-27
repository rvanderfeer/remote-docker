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
  Button,
  Alert,
  Divider,
} from '@mui/material';
import VerticalAlignBottomIcon from '@mui/icons-material/VerticalAlignBottom';
import CloseIcon from '@mui/icons-material/Close';
import RefreshIcon from '@mui/icons-material/Refresh';
import { Environment } from '../../App';

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

// ANSI color codes to CSS classes
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

// Function to colorize log lines with ANSI color codes
const colorizeLog = (line: string): string => {
  // Replace ANSI color codes with spans having CSS classes
  let colorized = line;

  // Basic ANSI color code regex
  const colorCodeRegex = /\u001b\[(3[0-7]|9[0-7])m(.*?)(\u001b\[0m|\u001b\[39m)/g;

  colorized = colorized.replace(colorCodeRegex, (match, colorCode, text) => {
    const className = ansiToColorClass[colorCode] || '';
    return `<span class="${className}">${text}</span>`;
  });

  // If no color codes were found, return the original text
  if (colorized === line) {
    return line;
  }

  return colorized;
};

const ContainerLogs: React.FC<ContainerLogsProps> = ({
                                                       activeEnvironment,
                                                       containerId,
                                                       containerName,
                                                       onClose,
                                                     }) => {
  const [logs, setLogs] = useState<string[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');
  const [autoScroll, setAutoScroll] = useState(true);
  const [follow, setFollow] = useState(true);
  const [tailLines, setTailLines] = useState(100);
  const [timestamps, setTimestamps] = useState(false);
  const [eventSource, setEventSource] = useState<EventSource | null>(null);

  const logsEndRef = useRef<HTMLDivElement>(null);
  const logsContainerRef = useRef<HTMLDivElement>(null);
  const ddClient = useDockerDesktopClient();

  // Function to scroll to bottom of logs
  const scrollToBottom = () => {
    if (logsEndRef.current) {
      logsEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  };

  // Handle scroll events to determine if we should auto-scroll
  const handleScroll = () => {
    if (!logsContainerRef.current) return;

    const { scrollTop, scrollHeight, clientHeight } = logsContainerRef.current;
    const atBottom = scrollHeight - scrollTop - clientHeight < 50;

    // Only change auto-scroll state if needed
    if (atBottom !== autoScroll) {
      setAutoScroll(atBottom);
    }
  };

  // Effect to scroll to bottom when logs update if autoScroll is enabled
  useEffect(() => {
    if (autoScroll && logs.length > 0) {
      scrollToBottom();
    }
  }, [logs, autoScroll]);

  // Load logs initially and set up streaming
  useEffect(() => {
    if (!activeEnvironment || !containerId) return;

    loadLogs();

    // Clean up on unmount
    return () => {
      if (eventSource) {
        eventSource.close();
      }
    };
  }, [activeEnvironment, containerId]);

  // Load logs from the container
  const loadLogs = async () => {
    if (!activeEnvironment || !containerId) {
      setError('No environment or container selected');
      return;
    }

    setIsLoading(true);
    setError('');
    setLogs([]);

    try {
      // Close existing event source if any
      if (eventSource) {
        eventSource.close();
        setEventSource(null);
      }

      // Create URL for the event source
      const urlParams = new URLSearchParams({
        hostname: activeEnvironment.hostname,
        username: activeEnvironment.username,
        containerId: containerId,
        tail: tailLines.toString(),
        follow: follow.toString(),
        timestamps: timestamps.toString(),
      });

      const url = `/container/logs?${urlParams.toString()}`;

      // Create new event source
      const es = new EventSource(url);

      es.onmessage = (event) => {
        const logLine = event.data;
        setLogs(prevLogs => [...prevLogs, logLine]);
      };

      es.onerror = (error) => {
        console.error('EventSource error:', error);
        es.close();
        setEventSource(null);
        setError('Log streaming error. Please try again.');
        setIsLoading(false);
      };

      es.onopen = () => {
        setIsLoading(false);
      };

      setEventSource(es);
    } catch (err: any) {
      console.error('Failed to load logs:', err);
      setError(`Failed to load logs: ${err.message || 'Unknown error'}`);
      setIsLoading(false);
    }
  };

  // Reload logs with current settings
  const handleReload = () => {
    loadLogs();
  };

  return (
    <Box sx={{
      display: 'flex',
      flexDirection: 'column',
      height: '100%',
      borderRadius: 1,
      overflow: 'hidden',
      bgcolor: 'background.paper',
    }}>
      {/* Header with controls */}
      <Box sx={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        p: 1,
        borderBottom: 1,
        borderColor: 'divider'
      }}>
        <Typography variant="h6" sx={{ fontSize: '1rem' }}>
          Logs: {containerName} ({containerId.substring(0, 12)})
        </Typography>

        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <FormControlLabel
            control={
              <Switch
                checked={follow}
                onChange={(e) => setFollow(e.target.checked)}
                size="small"
              />
            }
            label="Follow"
            sx={{ mr: 0 }}
          />

          <FormControlLabel
            control={
              <Switch
                checked={timestamps}
                onChange={(e) => setTimestamps(e.target.checked)}
                size="small"
              />
            }
            label="Timestamps"
            sx={{ mr: 0 }}
          />

          <TextField
            type="number"
            label="Tail lines"
            value={tailLines}
            onChange={(e) => setTailLines(Number(e.target.value))}
            size="small"
            InputProps={{
              inputProps: { min: 1 }
            }}
            sx={{ width: 100 }}
          />

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

      {/* Auto-scroll indicator */}
      <Box sx={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        px: 1,
        py: 0.5,
        fontSize: '0.75rem',
      }}>
        <span>
          {autoScroll ? 'Auto-scroll enabled' : 'Auto-scroll disabled'}
        </span>
        <FormControlLabel
          control={
            <Switch
              checked={autoScroll}
              onChange={(e) => setAutoScroll(e.target.checked)}
              size="small"
              color="default"
            />
          }
          label=""
          sx={{ m: 0 }}
        />
      </Box>

      {/* Error message */}
      {error && (
        <Alert severity="error" sx={{ m: 1 }}>
          {error}
        </Alert>
      )}

      {/* Logs content */}
      <Paper
        elevation={0}
        sx={{
          flexGrow: 1,
          overflow: 'auto',
          bgcolor: '#1e1e1e', // Dark background for logs
          color: '#d4d4d4',  // Light text for contrast
          p: 1,
          fontFamily: 'monospace',
          fontSize: '0.85rem',
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
          <Box sx={{
            display: 'flex',
            justifyContent: 'center',
            alignItems: 'center',
            height: '100%'
          }}>
            <CircularProgress color="inherit" size={24} />
          </Box>
        ) : logs.length === 0 ? (
          <Box sx={{
            display: 'flex',
            justifyContent: 'center',
            alignItems: 'center',
            height: '100%',
            color: 'text.secondary'
          }}>
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
                  __html: colorizeLog(line)
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