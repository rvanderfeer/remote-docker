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
  Chip,
  Drawer
} from '@mui/material';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import StopIcon from '@mui/icons-material/Stop';
import VisibilityIcon from '@mui/icons-material/Visibility';
import { Environment, ExtensionSettings } from '../../App';
import AutoRefreshControls from '../../components/AutoRefreshControls';
import ContainerLogs from './ContainerLogs';
import ConfirmationDialog from '../../components/ConfirmationDialog';

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
  isLogsOpen: boolean;
  setIsLogsOpen: (isOpen: boolean) => void;
}

const client = createDockerDesktopClient();

function useDockerDesktopClient() {
  return client;
}

const Containers: React.FC<ContainersProps> = ({
                                                 activeEnvironment,
                                                 settings,
                                                 isLogsOpen,
                                                 setIsLogsOpen
                                               }) => {
  const [containers, setContainers] = useState<Container[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');
  const ddClient = useDockerDesktopClient();

  // Auto-refresh states
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [refreshInterval, setRefreshInterval] = useState(30); // Default 30 seconds
  const [lastRefreshTime, setLastRefreshTime] = useState<Date | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false); // For refresh indicator overlay

  // Container logs states
  const [selectedContainer, setSelectedContainer] = useState<Container | null>(null);

  // Confirmation dialog states
  const [confirmDialogOpen, setConfirmDialogOpen] = useState(false);
  const [confirmAction, setConfirmAction] = useState<{
    type: 'start' | 'stop';
    container: Container | null;
  }>({ type: 'start', container: null });

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

  // View container logs
  const viewContainerLogs = (container: Container) => {
    setSelectedContainer(container);
    setIsLogsOpen(true); // Update parent component state
  };

  // Close logs drawer
  const closeLogs = () => {
    setIsLogsOpen(false); // Update parent component state
    setSelectedContainer(null);
  };

  // Handle action confirmation
  const handleConfirmAction = () => {
    if (!confirmAction.container) return;

    if (confirmAction.type === 'start') {
      startContainer(confirmAction.container.id);
    } else if (confirmAction.type === 'stop') {
      stopContainer(confirmAction.container.id);
    }

    setConfirmDialogOpen(false);
  };

  // Open confirmation dialog for starting a container
  const confirmStartContainer = (container: Container) => {
    setConfirmAction({
      type: 'start',
      container: container
    });
    setConfirmDialogOpen(true);
  };

  // Open confirmation dialog for stopping a container
  const confirmStopContainer = (container: Container) => {
    setConfirmAction({
      type: 'stop',
      container: container
    });
    setConfirmDialogOpen(true);
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
          isDisabled={!activeEnvironment || isLogsOpen}
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
                      <Box sx={{ display: 'flex', justifyContent: 'flex-end' }}>
                        {/* View logs button */}
                        <Tooltip title="View Logs">
                          <IconButton
                            size="small"
                            color="primary"
                            onClick={() => viewContainerLogs(container)}
                            disabled={isRefreshing || isLogsOpen}
                            sx={{ mr: 1 }}
                          >
                            <VisibilityIcon fontSize="small" />
                          </IconButton>
                        </Tooltip>

                        {/* Start/Stop button */}
                        {isRunning(container.status) ? (
                          <Tooltip title="Stop">
                            <IconButton
                              size="small"
                              color="error"
                              onClick={() => confirmStopContainer(container)}
                              disabled={isRefreshing || isLogsOpen}
                            >
                              <StopIcon fontSize="small" />
                            </IconButton>
                          </Tooltip>
                        ) : (
                          <Tooltip title="Start">
                            <IconButton
                              size="small"
                              color="success"
                              onClick={() => confirmStartContainer(container)}
                              disabled={isRefreshing || isLogsOpen}
                            >
                              <PlayArrowIcon fontSize="small" />
                            </IconButton>
                          </Tooltip>
                        )}
                      </Box>
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

      {/* Logs drawer */}
      <Drawer
        anchor="bottom"
        open={isLogsOpen}
        onClose={closeLogs}
        sx={{
          '& .MuiDrawer-paper': {
            height: '90%',
            boxShadow: 3,
            borderTopLeftRadius: 8,
            borderTopRightRadius: 8,
          },
        }}
      >
        {selectedContainer && (
          <Box sx={{ p: 2, height: '100%' }}>
            <ContainerLogs
              activeEnvironment={activeEnvironment}
              containerId={selectedContainer.id}
              containerName={selectedContainer.name}
              onClose={closeLogs}
            />
          </Box>
        )}
      </Drawer>

      {/* Confirmation Dialog */}
      <ConfirmationDialog
        open={confirmDialogOpen}
        title={confirmAction.type === 'start' ? 'Start Container' : 'Stop Container'}
        message={
          confirmAction.type === 'start'
            ? 'Are you sure you want to start this container?'
            : 'Are you sure you want to stop this container? Any running processes will be terminated.'
        }
        confirmText={confirmAction.type === 'start' ? 'Start' : 'Stop'}
        confirmColor={confirmAction.type === 'start' ? 'success' : 'error'}
        resourceName={confirmAction.container ? confirmAction.container.name : ''}
        onConfirm={handleConfirmAction}
        onCancel={() => setConfirmDialogOpen(false)}
      />
    </Box>
  );
};

export default Containers;