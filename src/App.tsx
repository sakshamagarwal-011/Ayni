import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { Layout } from './components/Layout';
import { Landing } from './pages/Landing';
import { CreateMeeting } from './pages/CreateMeeting';
import { JoinMeeting } from './pages/JoinMeeting';
import { MeetingLobby } from './pages/MeetingLobby';
import { RouteDiscovery } from './pages/RouteDiscovery';
import { SpotComparison } from './pages/SpotComparison';
import { FinalNavigation } from './pages/FinalNavigation';

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route element={<Layout />}>
          <Route path="/" element={<Landing />} />
          <Route path="/create" element={<CreateMeeting />} />
          <Route path="/join" element={<JoinMeeting />} />
          <Route path="/join/:code" element={<JoinMeeting />} />
          <Route path="/room/:code/lobby" element={<MeetingLobby />} />
          <Route path="/room/:code/routes" element={<RouteDiscovery />} />
          <Route path="/room/:code/compare" element={<SpotComparison />} />
          <Route path="/room/:code/navigate" element={<FinalNavigation />} />
          {/* Unknown room paths land on Join with an error-friendly entry point. */}
          <Route path="/room/:code" element={<Navigate to="/join" replace />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
