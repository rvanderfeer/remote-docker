import React, { useState, useEffect } from 'react';
import { createDockerDesktopClient } from '@docker/extension-api-client';
import {
  Alert,
  Box,
  CircularProgress,
  Paper,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Typography,
  IconButton,
  Tooltip,
  Chip
} from '@mui/material';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import StopIcon from '@mui/icons-material/Stop';
import { Environment, ExtensionSettings } from '../../App';
import AutoRefreshControls from '../../components/AutoRefreshControls';

// Container interface
interface Container {
  id: string;
  name: string;
  image: string;
  status: string;
}

// Error response interface
interface ErrorResponse {
  error: string;
  output?: string;
}

interface ContainersProps {
  activeEnvironment?: Environment;
  settings: ExtensionSettings;
}

const client = createDockerDesktopClient();

function useDockerDesktopClient() {
  return client;
}

const Containers: React.FC<ContainersProps> = ({ activeEnvironment, settings }) => {
  const [containers, setContainers] = useState<Container[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');
  const ddClient = useDockerDesktopClient();

  // Auto-refresh states
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [refreshInterval, setRefreshInterval] = useState(30); // Default 30 seconds
  const [lastRefreshTime, setLastRefreshTime] = useState<Date | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false); // For refresh indicator overlay

  // Load containers when active environment changes
  useEffect(() => {
    if (activeEnvironment) {
      loadContainers();
    } else {
      // Clear containers if no environment is selected
      setContainers([]);
    }
  }, [activeEnvironment]);

  // Auto-refresh interval setup
  useEffect(() => {
    let intervalId: NodeJS.Timeout | null = null;

    if (autoRefresh && activeEnvironment) {
      intervalId = setInterval(() => {
        loadContainers();
      }, refreshInterval * 1000);
    }

    // Cleanup function
    return () => {
      if (intervalId) {
        clearInterval(intervalId);
      }
    };
  }, [autoRefresh, refreshInterval, activeEnvironment]);

  // Reset auto-refresh when tab changes or component unmounts
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState !== 'visible') {
        setAutoRefresh(false);
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      setAutoRefresh(false);
    };
  }, []);

  // Load containers from the active environment
  const loadContainers = async () => {
    if (!activeEnvironment) {
      setError('No environment selected');
      return;
    }

    // For initial loading (empty containers list)
    if (containers.length === 0) {
      setIsLoading(true);
    } else {
      // For refreshing when we already have data
      setIsRefreshing(true);
    }

    setError('');

    try {
      // Check if Docker Desktop service is available
      if (!ddClient.extension?.vm?.service) {
        throw new Error('Docker Desktop service not available');
      }

      // Make API call to fetch containers
      const response = await ddClient.extension.vm.service.post('/connect', {
        hostname: activeEnvironment.hostname,
        username: activeEnvironment.username,
      });

      // Check for error response
      if (response && typeof response === 'object' && 'error' in response) {
        const errorResponse = response as ErrorResponse;
        throw new Error(errorResponse.error);
      }

      // Cast response to Container array
      const containerData = response as Container[];
      setContainers(containerData);
      setLastRefreshTime(new Date()); // Update last refresh time
      console.log('Containers loaded:', containerData);
    } catch (err: any) {
      console.error('Failed to load containers:', err);
      setError(`Failed to load containers: ${err.message || 'Unknown error'}`);
      setContainers([]);
    } finally {
      setIsLoading(false);
      setIsRefreshing(false);
    }
  };

  // Start a container
  const startContainer = async (containerId: string) => {
    if (!activeEnvironment) return;

    setIsRefreshing(true);
    try {
      if (!ddClient.extension?.vm?.service) {
        throw new Error('Docker Desktop service not available');
      }

      const response = await ddClient.extension.vm.service.post('/container/start', {
        hostname: activeEnvironment.hostname,
        username: activeEnvironment.username,
        containerId
      });

      if (response && typeof response === 'object' && 'error' in response) {
        const errorResponse = response as ErrorResponse;
        throw new Error(errorResponse.error);
      }

      // Reload containers after successful operation
      await loadContainers();
    } catch (err: any) {
      console.error('Failed to start container:', err);
      setError(`Failed to start container: ${err.message || 'Unknown error'}`);
      setIsRefreshing(false);
    }
  };

  // Stop a container
  const stopContainer = async (containerId: string) => {
    if (!activeEnvironment) return;

    setIsRefreshing(true);
    try {
      if (!ddClient.extension?.vm?.service) {
        throw new Error('Docker Desktop service not available');
      }

      const response = await ddClient.extension.vm.service.post('/container/stop', {
        hostname: activeEnvironment.hostname,
        username: activeEnvironment.username,
        containerId
      });

      if (response && typeof response === 'object' && 'error' in response) {
        const errorResponse = response as ErrorResponse;
        throw new Error(errorResponse.error);
      }

      // Reload containers after successful operation
      await loadContainers();
    } catch (err: any) {
      console.error('Failed to stop container:', err);
      setError(`Failed to stop container: ${err.message || 'Unknown error'}`);
      setIsRefreshing(false);
    }
  };

  // Check if a container is running
  const isRunning = (status: string): boolean => {
    return status.toLowerCase().includes('up');
  };

  // Auto-refresh handlers
  const handleAutoRefreshChange = (enabled: boolean) => {
    setAutoRefresh(enabled);
  };

  const handleIntervalChange = (interval: number) => {
    setRefreshInterval(interval);
  };

  return (
    <Box>
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 3 }}>
        <Typography variant="h5">Containers</Typography>

        <AutoRefreshControls
          autoRefresh={autoRefresh}
          refreshInterval={refreshInterval}
          lastRefreshTime={lastRefreshTime}
          isRefreshing={isRefreshing}
          isDisabled={!activeEnvironment}
          onRefreshClick={loadContainers}
          onAutoRefreshChange={handleAutoRefreshChange}
          onIntervalChange={handleIntervalChange}
        />
      </Box>

      {/* Warning when no environment is selected */}
      {!activeEnvironment ? (
        <Alert severity="info" sx={{ mb: 3 }}>
          Please select an environment to view containers.
        </Alert>
      ) : null}

      {/* Error message */}
      {error ? (
        <Alert severity="error" sx={{ mb: 3 }}>
          {error}
        </Alert>
      ) : null}

      {/* Loading indicator for initial load only */}
      {isLoading && !containers.length ? (
        <Box sx={{ display: 'flex', justifyContent: 'center', my: 3 }}>
          <CircularProgress />
        </Box>
      ) : null}

      {/* Containers table with refresh overlay */}
      {!isLoading && activeEnvironment && containers.length > 0 ? (
        <Box sx={{ position: 'relative' }}>
          {/* Refresh overlay */}
          {isRefreshing && (
            <Box
              sx={{
                position: 'absolute',
                top: 0,
                left: 0,
                right: 0,
                bottom: 0,
                display: 'flex',
                justifyContent: 'center',
                alignItems: 'center',
                backgroundColor: 'rgba(255, 255, 255, 0.7)',
                zIndex: 1,
                borderRadius: 1
              }}
            >
              <CircularProgress />
            </Box>
          )}

          <TableContainer component={Paper}>
            <Table sx={{ minWidth: 650 }}>
              <TableHead>
                <TableRow>
                  <TableCell width="15%">Container ID</TableCell>
                  <TableCell width="25%">Name</TableCell>
                  <TableCell width="30%">Image</TableCell>
                  <TableCell width="20%">Status</TableCell>
                  <TableCell width="10%" align="right">Actions</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {containers.map((container) => (
                  <TableRow key={container.id} hover>
                    <TableCell sx={{ fontFamily: 'monospace' }}>
                      {container.id.substring(0, 12)}
                    </TableCell>
                    <TableCell>{container.name}</TableCell>
                    <TableCell>{container.image}</TableCell>
                    <TableCell>
                      <Chip
                        label={container.status}
                        color={isRunning(container.status) ? 'success' : 'default'}
                        size="small"
                        variant="outlined"
                      />
                    </TableCell>
                    <TableCell align="right">
                      {isRunning(container.status) ? (
                        <Tooltip title="Stop">
                          <IconButton
                            size="small"
                            color="error"
                            onClick={() => stopContainer(container.id)}
                            disabled={isRefreshing}
                          >
                            <StopIcon fontSize="small" />
                          </IconButton>
                        </Tooltip>
                      ) : (
                        <Tooltip title="Start">
                          <IconButton
                            size="small"
                            color="success"
                            onClick={() => startContainer(container.id)}
                            disabled={isRefreshing}
                          >
                            <PlayArrowIcon fontSize="small" />
                          </IconButton>
                        </Tooltip>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
        </Box>
      ) : !isLoading && activeEnvironment ? (
        <Alert severity="info">
          No containers found in the selected environment.
        </Alert>
      ) : null}
    </Box>
  );
};

export default Containers;