import { Search } from "lucide-react";

interface Props {
  onOpen: () => void;
  destinationLabel?: string;
}

// Collapsed trigger pill only — the actual from/to form lives in a bottom
// sheet (SearchSheet) so it behaves like Google Maps / Uber on mobile,
// instead of an inline dropdown competing with the map for space.
export default function SearchBar({ onOpen, destinationLabel }: Props) {
  return (
    <button className="search-pill" onClick={onOpen}>
      <Search size={18} strokeWidth={2.2} />
      {destinationLabel || "你要去哪裡？"}
    </button>
  );
}
