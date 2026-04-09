export default function handler(req, res) {
  console.log('Ping function called');
  res.status(200).json({ ping: 'pong' });
}
