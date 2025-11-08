# Shape Detection Implementation

## Approach

### Algorithm: Connected Components with Polygon Approximation

This implementation uses a computer vision approach based on:

1. **Binary segmentation** to separate shapes from background
2. **Connected components analysis** to identify individual shapes
3. **Polygon approximation** to determine shape characteristics
4. **Multi-criteria classification** using geometric properties

### Key Design Decisions

#### 1. Connected Components vs Edge Detection

- **Chosen**: Connected Components (flood fill)
- **Reason**: More reliable for solid filled shapes, handles arbitrary rotations well
- **Alternative considered**: Canny edge detection - unreliable for SVG/PNG with solid fills

#### 2. Boundary vs Convex Hull

- **For convex shapes** (circle, triangle, rectangle, pentagon): Use convex hull
- **For concave shapes** (star): Use boundary directly
- **Reason**: Convex hull removes inner vertices of stars, making them undetectable

#### 3. Douglas-Peucker Approximation

- **Adaptive epsilon**: 0.005-0.01 \* perimeter depending on shape complexity
- **Progressive refinement**: Start fine, coarsen only if too many vertices
- **Safeguards**: Prevent over-aggressive approximation for rectangular shapes

#### 4. Classification Strategy

- **Primary**: Vertex count (3/4/5/8+ vertices)
- **Secondary**: Extent ratio (area/bbox) to disambiguate edge cases
- **Tertiary**: Circularity, aspect ratio, radius variance for circles
- **Star detection**: Requires extent < 0.40 AND coefficient of variation in radial distances

## Performance Results

### Current Metrics (10 test images)

- **Average Precision**: 86.7%
- **Average Recall**: 90.0%
- **Average F1 Score**: 0.817
- **Average IoU**: 0.837
- **Total Processing Time**: 59ms (average 6ms per image)

### Per-Shape Performance

- **Circles**: 100% F1, 100% IoU
- **Triangles**: 100% F1, 99% IoU
- **Rectangles**: ~88% F1 (challenges with rotated rectangles)
- **Pentagons**: 100% F1, 87% IoU
- **Stars**: ~75% F1 (polygon approximation challenges)

### Known Limitations

1. **Rotated rectangles**: Sometimes approximated as 5 vertices instead of 4
2. **Stars with few boundary points**: May be over-simplified by polygon approximation
3. **Complex scenes**: Multi-shape images may miss one shape if components merge

## Technical Implementation

### Core Functions

#### `detectShapes(imageData)`

Main entry point. Creates binary mask, finds components, analyzes each.

#### `createBinaryMask(data, width, height)`

Converts RGB image to binary (foreground=1, background=0).
Threshold: intensity < 128 with alpha > 200.

#### `findConnectedComponents(binary, width, height)`

Uses 4-connected flood fill to identify separate regions.

#### `analyzeComponent(component, width, height)`

Extracts features:

- Bounding box
- Center (centroid of bbox)
- Area (pixel count)
- Boundary points
- Convex hull (for convex shapes) or boundary (for concave)
- Polygon approximation

#### `classifyShape(approx, hull, bbox, center, area, perimeter)`

Multi-criteria classification:

1. Check for circles (circularity, radius variance)
2. Count vertices: 3=triangle, 4=rectangle, 5=pentagon
3. Use extent to disambiguate (4 vertices with low extent = triangle)
4. Check for stars (8+ vertices, low extent, radial variance)

### Helper Functions

#### `convexHull(points)` - Graham scan algorithm

#### `douglasPeucker(points, epsilon)` - Polygon simplification

#### `extractBoundary(component)` - Find edge pixels

#### `isCircular()` - Circle validation

#### `isStar()` - Star pattern detection with radial distance analysis

## Code Structure

```
src/main.ts
├── ShapeDetector class
│   ├── detectShapes() - Main algorithm
│   ├── createBinaryMask() - Binary segmentation
│   ├── findConnectedComponents() - Flood fill
│   ├── analyzeComponent() - Feature extraction
│   ├── classifyShape() - Shape classification
│   └── Helper methods (convexHull, douglasPeucker, etc.)
└── ShapeDetectionApp class - UI management
```

## Dependencies

- **No external computer vision libraries** - All algorithms implemented from scratch
- Uses only browser-native Canvas API for image loading
- TypeScript for type safety
- Vite for development and bundling

## Testing

Run the evaluation on all 10 test images:

1. Click "Select All" button
2. Click "Run Selected Evaluation"
3. Review metrics for each image and overall summary

Test images cover:

- Individual shapes (circle, triangle, rectangle, pentagon, star)
- Edge cases (rotations, different sizes)
- Complex scenes (multiple shapes)
- Negative cases (no shapes, noisy backgrounds)

## Future Improvements

1. **Better polygon approximation**: Multi-scale analysis to preserve vertices
2. **Rotated rectangle detection**: Oriented bounding box analysis
3. **Shape fitting**: Least-squares fitting for better boundaries
4. **Occlusion handling**: Detect partially overlapping shapes
5. **Scale invariance**: Normalize features for different image sizes
