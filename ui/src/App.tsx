import React, {useState} from 'react';
import Button from '@mui/material/Button';
import {createDockerDesktopClient} from '@docker/extension-api-client';
import {
  Alert,
  Box,
  CircularProgress,
  Paper,
  Stack,
  Table, TableBody, TableCell,
  TableContainer,
  TableHead, TableRow,
  TextField,
  Typography,
  useTheme
} from '@mui/material';

// Note: This line relies on Docker Desktop's presence as a host application.
// If you're running this React app in a browser, it won't work properly.
const client = createDockerDesktopClient();

function useDockerDesktopClient() {
  return client;
}

interface Container {
  id: string;
  name: string;
  image: string;
  status: string;
}

export function App() {
  const theme = useTheme();
  const [hostname, setHostname] = useState('');
  const [username, setUsername] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');
  const [containers, setContainers] = useState<Container[]>([]);

  const ddClient = useDockerDesktopClient();

  const connectToRemoteDocker = async () => {
    if (!hostname || !username) {
      setError('Hostname and username are required');
      return;
    }

    setIsLoading(true);
    setError('');
    setContainers([]);

    try {
      const result = await ddClient.extension.vm?.service?.post('/connect', {
        hostname,
        username,
      });

      // @ts-ignore
      if (result.error) {
        // @ts-ignore
        throw new Error(result.error);
      }

      // @ts-ignore
      setContainers(result);
    } catch (err: any) {
      console.error('Connection failed:', err);
      setError(`Connection failed: ${err.message || err}`);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <Box sx={{ p: 4 }}>
      <Typography variant="h4" gutterBottom>
        Remote Docker Connector
      </Typography>
      <Typography variant="body1" color="text.secondary" sx={{ mb: 4 }}>
        Connect to a remote Docker daemon using SSH and view containers.
      </Typography>

      <Paper sx={{ p: 3, mb: 4 }}>
        <Typography variant="h6" gutterBottom>
          Connection Details
        </Typography>

        <Stack direction="column" spacing={3}>
          <TextField
            label="Hostname"
            fullWidth
            value={hostname}
            onChange={(e) => setHostname(e.target.value)}
            placeholder="e.g., my-server.example.com or 192.168.1.100"
          />

          <TextField
            label="Username"
            fullWidth
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="SSH username"
          />

          <Typography variant="body2" color="text.secondary">
            This extension will use your SSH key from ~/.ssh/ to authenticate.
          </Typography>

          {error && (
            <Alert severity="error">{error}</Alert>
          )}

          <Button
            variant="contained"
            onClick={connectToRemoteDocker}
            disabled={isLoading}
            sx={{ alignSelf: 'flex-start' }}
          >
            {isLoading && <CircularProgress size="small" sx={{ mr: 1 }} />}
            {isLoading ? 'Connecting...' : 'Connect & List Containers'}
          </Button>
        </Stack>
      </Paper>

      {containers.length > 0 ? (
        <Box>
          <Typography variant="h6" gutterBottom>
            Remote Containers
          </Typography>

          <TableContainer component={Paper}>
            <Table sx={{ minWidth: 650 }}>
              <TableHead>
                <TableRow>
                  <TableCell>Container ID</TableCell>
                  <TableCell>Name</TableCell>
                  <TableCell>Image</TableCell>
                  <TableCell>Status</TableCell>
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
                    <TableCell
                      sx={{
                        color: container.status.toLowerCase().includes('up')
                          ? 'success.main'
                          : 'text.secondary'
                      }}
                    >
                      {container.status}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
        </Box>
      ) : isLoading ? null : (
        <Alert severity="info" sx={{ mt: 2 }}>
          No containers to display. Connect to a remote Docker daemon to view containers.
        </Alert>
      )}
    </Box>
  );
}