import { useState, useEffect, useRef } from 'react';

interface ArticleImageProps {
  article: any;
  className?: string;
}

export function ArticleImage({ article, className = '' }: ArticleImageProps) {
  const [currentImageIndex, setCurrentImageIndex] = useState(-1);
  const [allFailed, setAllFailed] = useState(false);
  const imgRef = useRef<HTMLImageElement>(null);

  // Build the full list of image URLs to try
  const imageUrls: string[] = [];
  
  // Use all image URLs from fallbackImageUrls (includes local, topImageUrl, and cachedImages)
  if (article.fallbackImageUrls?.length > 0) {
    imageUrls.push(...article.fallbackImageUrls);
  }

  // Reset when article changes
  useEffect(() => {
    setCurrentImageIndex(-1);
    setAllFailed(false);
  }, [article.savedId]);

  // Add error handler to suppress console errors
  useEffect(() => {
    const img = imgRef.current;
    if (!img) return;

    const handleError = (e: Event) => {
      e.preventDefault();
      return true;
    };

    // Add error event listener to prevent console errors
    img.addEventListener('error', handleError, true);

    return () => {
      img.removeEventListener('error', handleError, true);
    };
  }, [currentImageIndex, imageUrls.length]);

  const handleImageError = (e: React.SyntheticEvent<HTMLImageElement>) => {
    // Prevent the error from bubbling up to the console
    e.preventDefault();
    
    const nextIndex = currentImageIndex + 1;
    if (nextIndex < imageUrls.length) {
      setCurrentImageIndex(nextIndex);
    } else {
      setAllFailed(true);
    }
  };

  // If we have no images or all failed, show placeholder
  if (imageUrls.length === 0 || allFailed) {
    return (
      <svg
        className={className}
        viewBox="0 0 400 225"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
      >
        <rect width="400" height="225" fill="#f3f4f6" />
        <rect x="140" y="82.5" width="120" height="60" rx="4" fill="#e5e7eb" />
        <path
          d="M180 112.5L210 142.5L240 112.5"
          stroke="#9ca3af"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <circle cx="230" cy="102.5" r="8" fill="#9ca3af" />
      </svg>
    );
  }

  // Show the current image
  const currentUrl = currentImageIndex === -1 && imageUrls.length > 0 
    ? imageUrls[0] 
    : imageUrls[currentImageIndex];

  return (
    <img
      ref={imgRef}
      src={currentUrl}
      alt={article.title}
      className={className}
      onError={handleImageError}
      loading="lazy"
    />
  );
}