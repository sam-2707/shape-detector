import "./style.css";
import { SelectionManager } from "./ui-utils.js";
import { EvaluationManager } from "./evaluation-manager.js";

export interface Point {
  x: number;
  y: number;
}

export interface DetectedShape {
  type: "circle" | "triangle" | "rectangle" | "pentagon" | "star";
  confidence: number;
  boundingBox: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  center: Point;
  area: number;
}

export interface DetectionResult {
  shapes: DetectedShape[];
  processingTime: number;
  imageWidth: number;
  imageHeight: number;
}

export class ShapeDetector {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d")!;
  }

  /**
   * MAIN SHAPE DETECTION ALGORITHM
   * 
   * Approach: Connected Components with Polygon Approximation
   * 
   * Algorithm Steps:
   * 1. Create binary mask: Separate foreground (dark pixels) from background
   * 2. Find connected components: Use flood fill to identify separate regions
   * 3. Analyze each component:
   *    - Extract boundary points
   *    - Compute convex hull (for convex shapes) or use boundary (for concave shapes like stars)
   *    - Approximate polygon using Douglas-Peucker algorithm
   *    - Classify shape based on vertex count, extent, circularity, and aspect ratio
   * 
   * Key Features:
   * - Handles both convex shapes (circle, triangle, rectangle, pentagon) and concave shapes (star)
   * - Uses extent (area/bbox ratio) to distinguish similar shapes
   * - Adaptive polygon approximation based on shape complexity
   * - Fast processing with connected components approach
   * 
   * @param imageData - ImageData from canvas
   * @returns Promise<DetectionResult> - Detection results with shapes, processing time, and image dimensions
   */
  async detectShapes(imageData: ImageData): Promise<DetectionResult> {
    const startTime = performance.now();

    const shapes: DetectedShape[] = [];
    const width = imageData.width;
    const height = imageData.height;
    const data = imageData.data;

    console.log(`Image size: ${width}x${height}`);
    
    // Step 1: Create binary mask
    const binary = this.createBinaryMask(data, width, height);
    
    // Step 2: Find connected components
    const components = this.findConnectedComponents(binary, width, height);
    
    console.log(`Found ${components.length} components`);
    
    // Step 3: Analyze each component
    for (const component of components) {
      // Lower threshold to catch smaller shapes
      if (component.length < 50) {
        console.log(`Skipping small component: ${component.length} pixels`);
        continue;
      }
      
      const shape = this.analyzeComponent(component, width, height);
      if (shape) {
        shapes.push(shape);
      }
    }

    const processingTime = performance.now() - startTime;

    return {
      shapes,
      processingTime,
      imageWidth: width,
      imageHeight: height,
    };
  }

  /**
   * Create binary mask separating foreground from background
   * 
   * Strategy: Detect dark pixels (shapes are typically black on white/light background)
   * Threshold: intensity < 128 with alpha > 200 (opaque dark pixels)
   */
  private createBinaryMask(data: Uint8ClampedArray, width: number, height: number): Uint8ClampedArray {
    const binary = new Uint8ClampedArray(width * height);
    let foregroundPixels = 0;
    
    for (let i = 0; i < width * height; i++) {
      const r = data[i * 4];
      const g = data[i * 4 + 1];
      const b = data[i * 4 + 2];
      const a = data[i * 4 + 3];
      
      const intensity = (r + g + b) / 3;
      
      // Foreground: dark pixels (black shapes) or opaque non-white pixels
      if (a > 200 && intensity < 128) {
        binary[i] = 1; // Foreground
        foregroundPixels++;
      } else {
        binary[i] = 0; // Background
      }
    }
    
    console.log(`Binary mask: ${foregroundPixels} foreground pixels out of ${width * height} total`);
    
    return binary;
  }

  /**
   * Find connected components using flood fill
   * 
   * Uses 4-connected flood fill to identify separate regions in the binary mask.
   * Each component represents a potential shape.
   */
  private findConnectedComponents(binary: Uint8ClampedArray, width: number, height: number): Point[][] {
    const labeled = new Uint8ClampedArray(width * height);
    const components: Point[][] = [];
    
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const idx = y * width + x;
        if (binary[idx] === 1 && labeled[idx] === 0) {
          const component = this.floodFill(binary, labeled, x, y, width, height);
          if (component.length > 0) {
            components.push(component);
          }
        }
      }
    }
    
    return components;
  }

  /**
   * Flood fill to extract connected component
   */
  private floodFill(
    binary: Uint8ClampedArray,
    labeled: Uint8ClampedArray,
    startX: number,
    startY: number,
    width: number,
    height: number
  ): Point[] {
    const component: Point[] = [];
    const stack: Point[] = [{ x: startX, y: startY }];
    
    while (stack.length > 0) {
      const { x, y } = stack.pop()!;
      
      if (x < 0 || x >= width || y < 0 || y >= height) continue;
      
      const idx = y * width + x;
      if (binary[idx] === 0 || labeled[idx] === 1) continue;
      
      labeled[idx] = 1;
      component.push({ x, y });
      
      // 4-connected neighbors
      stack.push({ x: x + 1, y });
      stack.push({ x: x - 1, y });
      stack.push({ x, y: y + 1 });
      stack.push({ x, y: y - 1 });
    }
    
    return component;
  }

  /**
   * Analyze a connected component and classify shape
   * 
   * Process:
   * 1. Calculate bounding box and center
   * 2. Extract boundary points
   * 3. Compute convex hull OR use boundary for concave shapes
   * 4. Approximate polygon with adaptive epsilon
   * 5. Classify based on vertices, extent, circularity
   * 
   * Key Decision: For very concave shapes (extent < 0.40), use boundary instead of hull
   * to preserve star's inner vertices that would be lost with convex hull.
   */
  private analyzeComponent(component: Point[], width: number, height: number): DetectedShape | null {
    // Calculate bounding box
    let minX = width, maxX = 0, minY = height, maxY = 0;
    for (const p of component) {
      minX = Math.min(minX, p.x);
      maxX = Math.max(maxX, p.x);
      minY = Math.min(minY, p.y);
      maxY = Math.max(maxY, p.y);
    }
    
    const bbox = {
      x: minX,
      y: minY,
      width: maxX - minX + 1,
      height: maxY - minY + 1
    };
    
    console.log(`Component: pixels=${component.length}, bbox=${bbox.width}x${bbox.height} at (${bbox.x},${bbox.y})`);
    
    if (bbox.width < 10 || bbox.height < 10) {
      console.log(`  Filtered: too small (${bbox.width}x${bbox.height})`);
      return null;
    }
    
    // Calculate center
    const centerX = (minX + maxX) / 2;
    const centerY = (minY + maxY) / 2;
    const center = { x: centerX, y: centerY };
    
    // Area is pixel count
    const pixelArea = component.length;
    
    // Extract boundary for shape analysis
    const boundary = this.extractBoundary(component, width, height);
    console.log(`  Boundary points: ${boundary.length}`);
    
    if (boundary.length < 8) {
      console.log(`  Filtered: boundary too small (${boundary.length})`);
      return null;
    }
    
    // Get convex hull for classification
    const hull = this.convexHull(boundary);
    console.log(`  Hull points: ${hull.length}`);
    
    // Calculate basic shape properties first to determine approximation strategy
    const bboxArea = bbox.width * bbox.height;
    const extent = pixelArea / bboxArea;
    
    // For stars, convex hull removes the concave parts!
    // We need to check extent FIRST, then decide which contour to use
    let contourToUse: Point[];
    let perimeter: number;
    
    if (extent < 0.40) {
      // Very concave - likely a star
      // Use boundary directly instead of hull to preserve concave vertices
      console.log(`  ⭐ Very concave shape (extent=${extent.toFixed(3)}) - using boundary for star detection`);
      contourToUse = boundary;
      perimeter = this.calculatePerimeter(boundary);
    } else if (hull.length < 4 && extent > 0.80) {
      // Hull failed to capture all corners - use boundary
      console.log(`  ⚠️ Hull has too few points (${hull.length}), using boundary for extent=${extent.toFixed(3)}`);
      contourToUse = boundary;
      perimeter = this.calculatePerimeter(boundary);
    } else {
      // Convex or moderately concave - use hull
      contourToUse = hull;
      perimeter = this.calculatePerimeter(hull);
    }
    
    const circularity = (4 * Math.PI * pixelArea) / (perimeter * perimeter);
    
    console.log(`  Pre-check: extent=${extent.toFixed(3)}, circ=${circularity.toFixed(3)}, contour=${contourToUse.length} points`);
    
    // Approximate the contour
    let approx: Point[];
    if (extent < 0.40) {
      // Star candidate - use very fine approximation on boundary
      const epsilon = 0.01 * perimeter; // Fine enough to preserve star points
      approx = this.douglasPeucker(contourToUse, epsilon);
      console.log(`  Star approximation: ${approx.length} vertices (from boundary)`);
    } else {
      // Regular shape - use fine approximation
      const epsilon = 0.01 * perimeter;
      approx = this.douglasPeucker(contourToUse, epsilon);
      console.log(`  Regular approximation: ${approx.length} vertices (epsilon=${epsilon.toFixed(2)})`);
      
      // If still too few vertices, try even finer epsilon
      if (approx.length < 4 && extent > 0.80) {
        console.log(`  ⚠️ Too few vertices (${approx.length}), trying finer epsilon`);
        const finerEpsilon = 0.005 * perimeter;
        approx = this.douglasPeucker(contourToUse, finerEpsilon);
        console.log(`  Finer approximation: ${approx.length} vertices (epsilon=${finerEpsilon.toFixed(2)})`);
        
        // If finer gives good results, keep it
        if (approx.length >= 4 && approx.length <= 12) {
          console.log(`  ✓ Finer approximation successful, using ${approx.length} vertices`);
        }
      }
      
      // Still too few? Sample the contour
      if (approx.length < 4 && extent > 0.80) {
        console.log(`  ⚠️ Still too few vertices, sampling contour`);
        approx = this.samplePoints(contourToUse, Math.min(contourToUse.length, 12));
      }
      
      // If we get too many vertices, try coarser approximation (but not if we already have too few!)
      if (approx.length > 12 && !(extent > 0.80 && approx.length < 20)) {
        const coarserEpsilon = 0.03 * perimeter;
        const coarserApprox = this.douglasPeucker(contourToUse, coarserEpsilon);
        console.log(`  Coarser approximation: ${coarserApprox.length} vertices`);
        // Only use coarser if it's reasonable (not too few)
        if (coarserApprox.length >= 4) {
          approx = coarserApprox;
        } else {
          console.log(`  ⚠️ Coarser too aggressive, keeping ${approx.length} vertices`);
        }
      }
    }
    
    console.log(`  Final approximation: ${approx.length} vertices`);
    
    // Classify shape using the final approximation
    const classification = this.classifyShape(approx, hull, bbox, center, pixelArea, perimeter);
    
    if (!classification) {
      console.log(`  Classification failed`);
      return null;
    }
    
    console.log(`  ✓ Detected: ${classification.type} (confidence: ${(classification.confidence * 100).toFixed(1)}%)`);
    
    return {
      type: classification.type,
      confidence: classification.confidence,
      boundingBox: bbox,
      center: center,
      area: pixelArea
    };
  }

  /**
   * Extract boundary points of a component
   */
  private extractBoundary(component: Point[], width: number, height: number): Point[] {
    const componentSet = new Set(component.map(p => p.y * width + p.x));
    const boundary: Point[] = [];
    
    for (const p of component) {
      // Check if this point has a background neighbor
      const neighbors = [
        { x: p.x + 1, y: p.y },
        { x: p.x - 1, y: p.y },
        { x: p.x, y: p.y + 1 },
        { x: p.x, y: p.y - 1 }
      ];
      
      for (const n of neighbors) {
        if (n.x >= 0 && n.x < width && n.y >= 0 && n.y < height) {
          const nIdx = n.y * width + n.x;
          if (!componentSet.has(nIdx)) {
            boundary.push(p);
            break;
          }
        }
      }
    }
    
    return boundary;
  }

  /**
   * Classify shape based on approximated polygon
   * 
   * Classification Strategy:
   * - Primary: Vertex count (3=triangle, 4=rectangle, 5=pentagon, 8+=star)
   * - Secondary: Extent ratio (area/bbox) to disambiguate edge cases
   * - Tertiary: Circularity and aspect ratio for circles
   * 
   * Extent-based disambiguation:
   * - Triangles: extent ~0.50 (half of bbox)
   * - Rectangles: extent >0.70 (fill bbox well)
   * - Stars: extent <0.40 (very concave)
   * - Circles: extent >0.70 + circularity >0.70
   */
  private classifyShape(
    approx: Point[],
    hull: Point[],
    bbox: { x: number; y: number; width: number; height: number },
    center: Point,
    area: number,
    perimeter: number
  ): { type: DetectedShape["type"]; confidence: number } | null {
    const vertices = approx.length;
    const aspectRatio = bbox.width / bbox.height;
    const bboxArea = bbox.width * bbox.height;
    const extent = area / bboxArea;
    const circularity = (4 * Math.PI * area) / (perimeter * perimeter);
    
    console.log(`    Classify: v=${vertices}, extent=${extent.toFixed(3)}, circ=${circularity.toFixed(3)}, aspect=${aspectRatio.toFixed(2)}`);
    
    // Circle detection - must come first
    const isCirc = this.isCircular(hull, center, bbox, circularity, extent, aspectRatio);
    console.log(`    Circle test: ${isCirc}`);
    if (isCirc) {
      return { type: "circle", confidence: 0.90 + Math.min(0.08, circularity * 0.1) };
    }
    
    // Triangle: 3 vertices - check BEFORE stars to avoid confusion
    if (vertices === 3) {
      console.log(`    ▲ Triangle (3 vertices)`);
      return { type: "triangle", confidence: 0.92 };
    }
    
    // Rectangle/Square: 4 vertices with HIGH extent (fills bounding box)
    if (vertices === 4 && extent > 0.70) {
      console.log(`    ▢ Rectangle (4 vertices, high extent)`);
      return { type: "rectangle", confidence: extent > 0.85 ? 0.95 : 0.88 };
    }
    
    // Triangle with 4 vertices (over-approximated) - low extent indicates triangle
    if (vertices === 4 && extent < 0.60) {
      console.log(`    ▲ Triangle (4v but low extent=${extent.toFixed(3)})`);
      return { type: "triangle", confidence: 0.85 };
    }
    
    // Pentagon: 5 vertices with HIGH extent (not rotated rectangle)
    if (vertices === 5 && extent > 0.65) {
      console.log(`    ⬠ Pentagon (5 vertices, convex)`);
      return { type: "pentagon", confidence: extent > 0.75 ? 0.88 : 0.80 };
    }
    
    // Rectangle with 5 vertices (extra vertex from rotation) - medium-high extent
    if (vertices === 5 && extent > 0.45 && extent <= 0.65 && aspectRatio > 0.7 && aspectRatio < 1.5) {
      console.log(`    ▢ Rectangle (5v but rectangle-like extent=${extent.toFixed(3)})`);
      return { type: "rectangle", confidence: 0.82 };
    }
    
    // Star detection - MUST have many vertices (8+) AND be concave
    if (vertices >= 8 && extent < 0.50) {
      const isSt = this.isStar(hull, center, vertices, extent);
      console.log(`    Star test (v>=8, extent<0.50): ${isSt}`);
      if (isSt) {
        return { type: "star", confidence: 0.85 };
      }
    }
    
    // Star with moderate vertices (6-7) but very concave
    if (vertices >= 6 && vertices <= 7 && extent < 0.38) {
      const isSt = this.isStar(hull, center, vertices, extent);
      console.log(`    Star test (v=${vertices}, very concave): ${isSt}`);
      if (isSt) {
        return { type: "star", confidence: 0.75 };
      }
    }
    
    // Rectangle with moderate extent (4 vertices, fallback)
    if (vertices === 4) {
      console.log(`    → Rectangle (4 vertices, fallback)`);
      return { type: "rectangle", confidence: 0.78 };
    }
    
    // Triangle or Pentagon with 5 vertices - use extent to disambiguate
    if (vertices === 5) {
      if (extent < 0.55) {
        console.log(`    → Triangle (5v, low extent)`);
        return { type: "triangle", confidence: 0.70 };
      }
      console.log(`    → Pentagon (5 vertices, fallback)`);
      return { type: "pentagon", confidence: 0.75 };
    }
    
    // Handle edge cases with different vertex counts
    if (vertices === 6) {
      console.log(`    6 vertices: extent=${extent.toFixed(3)}`);
      // Could be pentagon with extra vertex
      if (extent > 0.50) {
        console.log(`    → Pentagon (6v, convex)`);
        return { type: "pentagon", confidence: 0.70 };
      }
    }
    
    // Star with many vertices but high extent (unlikely but possible)
    if (vertices >= 7 && extent < 0.50) {
      console.log(`    → Star (${vertices}v, very concave)`);
      return { type: "star", confidence: 0.70 };
    }
    
    // High vertex count shapes - likely polygons or complex shapes
    if (vertices >= 10) {
      console.log(`    → Complex shape (${vertices}v)`);
      if (extent < 0.60) {
        return { type: "star", confidence: 0.65 };
      }
      // High extent, many vertices - could be rounded rectangle or polygon
      if (extent > 0.80) {
        return { type: "rectangle", confidence: 0.60 };
      }
    }
    
    // Very few vertices - fallback to extent-based classification
    if (vertices === 2) {
      console.log(`    ⚠️ Only 2 vertices - using extent for classification`);
      if (extent > 0.85) {
        return { type: "rectangle", confidence: 0.70 };
      }
    }
    
    console.log(`    No clear match for ${vertices} vertices`);
    return null;
  }

  /**
   * Check if shape is circular
   */
  private isCircular(
    hull: Point[],
    center: Point,
    bbox: { width: number; height: number },
    circularity: number,
    extent: number,
    aspectRatio: number
  ): boolean {
    console.log(`      isCircular: aspect=${aspectRatio.toFixed(2)}, circ=${circularity.toFixed(3)}, extent=${extent.toFixed(3)}`);
    
    // Must have square-ish aspect ratio
    if (Math.abs(aspectRatio - 1.0) > 0.25) {
      console.log(`      isCircular: NO - aspect ratio off`);
      return false;
    }
    
    // Must have high circularity and extent
    if (circularity < 0.70 || extent < 0.70) {
      console.log(`      isCircular: NO - circularity or extent too low`);
      return false;
    }
    
    // Check radius variance
    const radius = (bbox.width + bbox.height) / 4;
    let sumError = 0;
    for (const p of hull) {
      const dist = Math.sqrt((p.x - center.x) ** 2 + (p.y - center.y) ** 2);
      sumError += Math.abs(dist - radius) / radius;
    }
    const avgError = sumError / hull.length;
    
    console.log(`      isCircular: radius error=${avgError.toFixed(3)} (need <0.20)`);
    
    const result = avgError < 0.20;
    console.log(`      isCircular: ${result ? 'YES' : 'NO'}`);
    return result;
  }

  /**
   * Check if shape is a star
   */
  private isStar(hull: Point[], center: Point, vertices: number, extent: number): boolean {
    // Stars are concave shapes with specific characteristics
    // They typically have 10 vertices (5 points) when approximated
    // or 8-14 vertices depending on approximation
    
    console.log(`      isStar check: vertices=${vertices}, extent=${extent.toFixed(3)}`);
    
    // Must be concave (low extent)
    if (extent > 0.50) {
      console.log(`      isStar: NO - extent too high (${extent.toFixed(3)} > 0.50)`);
      return false;
    }
    
    // Allow wider range of vertices (stars can be approximated differently)
    if (vertices < 6 || vertices > 25) {
      console.log(`      isStar: NO - vertices out of range (${vertices} not in 6-25)`);
      return false;
    }
    
    // Check for alternating distances from center (star pattern)
    const distances: number[] = [];
    for (const p of hull) {
      distances.push(Math.sqrt((p.x - center.x) ** 2 + (p.y - center.y) ** 2));
    }
    
    if (distances.length < 8) {
      console.log(`      isStar: NO - not enough hull points (${distances.length} < 8)`);
      return false;
    }
    
    // Calculate variance in distances - stars have high variance
    const avgDist = distances.reduce((a, b) => a + b) / distances.length;
    const variance = distances.reduce((sum, d) => sum + (d - avgDist) ** 2, 0) / distances.length;
    const stdDev = Math.sqrt(variance);
    const coefficientOfVariation = stdDev / avgDist;
    
    console.log(`      isStar: CoV=${coefficientOfVariation.toFixed(3)} (need >=0.10)`);
    
    // Stars have high variation in radial distances
    // Lowered threshold to catch more stars
    if (coefficientOfVariation < 0.10) {
      console.log(`      isStar: NO - CoV too low`);
      return false;
    }
    
    // Additional check: look for alternating pattern
    let alternations = 0;
    for (let i = 0; i < distances.length; i++) {
      const curr = distances[i];
      const next = distances[(i + 1) % distances.length];
      if (Math.abs(curr - next) > avgDist * 0.15) {
        alternations++;
      }
    }
    
    // Lower threshold for alternations (more lenient for approximated shapes)
    const minAlternations = Math.min(4, Math.floor(distances.length * 0.3));
    console.log(`      isStar: alternations=${alternations} (need >=${minAlternations})`);
    
    // Should have multiple alternations for star pattern
    const result = alternations >= minAlternations;
    console.log(`      isStar: ${result ? 'YES' : 'NO'}`);
    return result;
  }



  /**
   * Calculate perimeter of a contour
   */
  private calculatePerimeter(contour: Point[]): number {
    let perimeter = 0;
    for (let i = 0; i < contour.length; i++) {
      const p1 = contour[i];
      const p2 = contour[(i + 1) % contour.length];
      perimeter += Math.sqrt(Math.pow(p2.x - p1.x, 2) + Math.pow(p2.y - p1.y, 2));
    }
    return perimeter;
  }

  /**
   * Convex hull using Graham scan
   */
  private convexHull(points: Point[]): Point[] {
    if (points.length < 3) return points;
    
    // Find the bottom-most point (or left-most in case of tie)
    let bottom = points[0];
    for (const p of points) {
      if (p.y > bottom.y || (p.y === bottom.y && p.x < bottom.x)) {
        bottom = p;
      }
    }
    
    // Sort points by polar angle with respect to bottom point
    const sorted = points.slice().sort((a, b) => {
      const angleA = Math.atan2(a.y - bottom.y, a.x - bottom.x);
      const angleB = Math.atan2(b.y - bottom.y, b.x - bottom.x);
      return angleA - angleB;
    });
    
    const hull: Point[] = [];
    for (const p of sorted) {
      while (hull.length >= 2 && this.crossProduct(hull[hull.length - 2], hull[hull.length - 1], p) <= 0) {
        hull.pop();
      }
      hull.push(p);
    }
    
    return hull;
  }

  /**
   * Cross product for orientation test
   */
  private crossProduct(o: Point, a: Point, b: Point): number {
    return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  }

  /**
   * Sample N evenly-spaced points from a contour
   */
  private samplePoints(points: Point[], n: number): Point[] {
    if (points.length <= n) return points;
    
    const sampled: Point[] = [];
    const step = points.length / n;
    
    for (let i = 0; i < n; i++) {
      const idx = Math.floor(i * step);
      sampled.push(points[idx]);
    }
    
    return sampled;
  }

  /**
   * Douglas-Peucker algorithm for polygon approximation
   * 
   * Recursively simplifies a curve by removing points that are within
   * epsilon distance from the line connecting endpoints.
   * 
   * Adaptive epsilon values:
   * - 0.01 * perimeter: Standard approximation for regular shapes
   * - 0.005 * perimeter: Finer approximation for rectangles
   * - 0.01 * perimeter: For star boundaries (preserves concave vertices)
   */
  private douglasPeucker(points: Point[], epsilon: number): Point[] {
    if (points.length < 3) return points;
    
    let maxDist = 0;
    let index = 0;
    const end = points.length - 1;
    
    for (let i = 1; i < end; i++) {
      const dist = this.perpendicularDistance(points[i], points[0], points[end]);
      if (dist > maxDist) {
        maxDist = dist;
        index = i;
      }
    }
    
    if (maxDist > epsilon) {
      const left = this.douglasPeucker(points.slice(0, index + 1), epsilon);
      const right = this.douglasPeucker(points.slice(index), epsilon);
      return left.slice(0, -1).concat(right);
    } else {
      return [points[0], points[end]];
    }
  }

  /**
   * Calculate perpendicular distance from point to line
   */
  private perpendicularDistance(point: Point, lineStart: Point, lineEnd: Point): number {
    const dx = lineEnd.x - lineStart.x;
    const dy = lineEnd.y - lineStart.y;
    const num = Math.abs(dy * point.x - dx * point.y + lineEnd.x * lineStart.y - lineEnd.y * lineStart.x);
    const den = Math.sqrt(dx * dx + dy * dy);
    return num / den;
  }



  loadImage(file: File): Promise<ImageData> {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        this.canvas.width = img.width;
        this.canvas.height = img.height;
        this.ctx.drawImage(img, 0, 0);
        const imageData = this.ctx.getImageData(0, 0, img.width, img.height);
        resolve(imageData);
      };
      img.onerror = reject;
      img.src = URL.createObjectURL(file);
    });
  }
}

class ShapeDetectionApp {
  private detector: ShapeDetector;
  private imageInput: HTMLInputElement;
  private resultsDiv: HTMLDivElement;
  private testImagesDiv: HTMLDivElement;
  private evaluateButton: HTMLButtonElement;
  private evaluationResultsDiv: HTMLDivElement;
  private selectionManager: SelectionManager;
  private evaluationManager: EvaluationManager;

  constructor() {
    const canvas = document.getElementById(
      "originalCanvas"
    ) as HTMLCanvasElement;
    this.detector = new ShapeDetector(canvas);

    this.imageInput = document.getElementById("imageInput") as HTMLInputElement;
    this.resultsDiv = document.getElementById("results") as HTMLDivElement;
    this.testImagesDiv = document.getElementById(
      "testImages"
    ) as HTMLDivElement;
    this.evaluateButton = document.getElementById(
      "evaluateButton"
    ) as HTMLButtonElement;
    this.evaluationResultsDiv = document.getElementById(
      "evaluationResults"
    ) as HTMLDivElement;

    this.selectionManager = new SelectionManager();
    this.evaluationManager = new EvaluationManager(
      this.detector,
      this.evaluateButton,
      this.evaluationResultsDiv
    );

    this.setupEventListeners();
    this.loadTestImages().catch(console.error);
  }

  private setupEventListeners(): void {
    this.imageInput.addEventListener("change", async (event) => {
      const file = (event.target as HTMLInputElement).files?.[0];
      if (file) {
        await this.processImage(file);
      }
    });

    this.evaluateButton.addEventListener("click", async () => {
      const selectedImages = this.selectionManager.getSelectedImages();
      await this.evaluationManager.runSelectedEvaluation(selectedImages);
    });
  }

  private async processImage(file: File): Promise<void> {
    try {
      this.resultsDiv.innerHTML = "<p>Processing...</p>";

      const imageData = await this.detector.loadImage(file);
      const results = await this.detector.detectShapes(imageData);

      this.displayResults(results);
    } catch (error) {
      this.resultsDiv.innerHTML = `<p>Error: ${error}</p>`;
    }
  }

  private displayResults(results: DetectionResult): void {
    const { shapes, processingTime } = results;

    let html = `
      <p><strong>Processing Time:</strong> ${processingTime.toFixed(2)}ms</p>
      <p><strong>Shapes Found:</strong> ${shapes.length}</p>
    `;

    if (shapes.length > 0) {
      html += "<h4>Detected Shapes:</h4><ul>";
      shapes.forEach((shape) => {
        html += `
          <li>
            <strong>${
              shape.type.charAt(0).toUpperCase() + shape.type.slice(1)
            }</strong><br>
            Confidence: ${(shape.confidence * 100).toFixed(1)}%<br>
            Center: (${shape.center.x.toFixed(1)}, ${shape.center.y.toFixed(
          1
        )})<br>
            Area: ${shape.area.toFixed(1)}px²
          </li>
        `;
      });
      html += "</ul>";
    } else {
      html +=
        "<p>No shapes detected. Please implement the detection algorithm.</p>";
    }

    this.resultsDiv.innerHTML = html;
  }

  private async loadTestImages(): Promise<void> {
    try {
      const module = await import("./test-images-data.js");
      const testImages = module.testImages;
      const imageNames = module.getAllTestImageNames();

      let html =
        '<h4>Click to upload your own image or use test images for detection. Right-click test images to select/deselect for evaluation:</h4><div class="evaluation-controls"><button id="selectAllBtn">Select All</button><button id="deselectAllBtn">Deselect All</button><span class="selection-info">0 images selected</span></div><div class="test-images-grid">';

      // Add upload functionality as first grid item
      html += `
        <div class="test-image-item upload-item" onclick="triggerFileUpload()">
          <div class="upload-icon">📁</div>
          <div class="upload-text">Upload Image</div>
          <div class="upload-subtext">Click to select file</div>
        </div>
      `;

      imageNames.forEach((imageName) => {
        const dataUrl = testImages[imageName as keyof typeof testImages];
        const displayName = imageName
          .replace(/[_-]/g, " ")
          .replace(/\.(svg|png)$/i, "");
        html += `
          <div class="test-image-item" data-image="${imageName}" 
               onclick="loadTestImage('${imageName}', '${dataUrl}')" 
               oncontextmenu="toggleImageSelection(event, '${imageName}')">
            <img src="${dataUrl}" alt="${imageName}">
            <div>${displayName}</div>
          </div>
        `;
      });

      html += "</div>";
      this.testImagesDiv.innerHTML = html;

      this.selectionManager.setupSelectionControls();

      (window as any).loadTestImage = async (name: string, dataUrl: string) => {
        try {
          const response = await fetch(dataUrl);
          const blob = await response.blob();
          const file = new File([blob], name, { type: "image/svg+xml" });

          const imageData = await this.detector.loadImage(file);
          const results = await this.detector.detectShapes(imageData);
          this.displayResults(results);

          console.log(`Loaded test image: ${name}`);
        } catch (error) {
          console.error("Error loading test image:", error);
        }
      };

      (window as any).toggleImageSelection = (
        event: MouseEvent,
        imageName: string
      ) => {
        event.preventDefault();
        this.selectionManager.toggleImageSelection(imageName);
      };

      // Add upload functionality
      (window as any).triggerFileUpload = () => {
        this.imageInput.click();
      };
    } catch (error) {
      this.testImagesDiv.innerHTML = `
        <p>Test images not available. Run 'node convert-svg-to-png.js' to generate test image data.</p>
        <p>SVG files are available in the test-images/ directory.</p>
      `;
    }
  }
}

document.addEventListener("DOMContentLoaded", () => {
  new ShapeDetectionApp();
});
