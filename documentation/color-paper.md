Semantic Color Mapping: A Pipeline for Assigning Meaningful Colors to Text 

### ABSTRACT

Current visual text analytics applications do not regard color assignment as a prominent design consideration. We argue that there is a need for applying meaningful colors to text, enhancing comprehension and comparability. Hence, in this paper, we present a guideline to facilitate the choice of colors in text visualizations. The semantic color mapping pipeline is derived from literature and experiences in text visualization design and sums up design considerations, lessons learned, and best practices. The proposed pipeline starts by extracting labeled data from raw text, choosing an aggregation level to create an appropriate vector representation, then defining the unit of analysis to project the data into a low-dimensional space, and finally assigning colors based on the selected color space. We argue that applying such a pipeline enhances the understanding of attribute relations in text visualizations, as confirmed by two applications.

---

## 1 INTRODUCTION

Color is one of the most prominent visual variables in visualization design. Mapping data variables and attributes to semantically meaningful colors is among the main challenges for visualization creators. From mapping concepts to colors based on cultural references to mapping them based on image queries, researchers have suggested a multitude of techniques to bestow meaning to color. However, we need an alternative color assignment technique for applications where concepts do not have an inherent color association or where the distribution of color assignments would not make full use of the available color space.

This challenge is quite apparent for text data visualization. Text data is usually processed using computational linguistics algorithms before it is visualized. After processing, the raw (unstructured) text data is commonly transformed into (structured) hierarchical and high-dimensional data. For example, frequent concepts, topics, emotions, named entities, or other attributes can be extracted and visualized. Most commonly, these attributes are assigned colors based on a categorical color mapping that does not depict the inherent relation between the attributes. Surveys of text visualizations show the lack of thoughtful color assignment in existing approaches.

As an example, let us consider an application that analyzes the thematic structure of a document collection and assigns a topic to each document. These topics are represented by some keywords as descriptors, and each document can also be represented by a set of keywords. Each document and topic keyword is, in turn, represented by an embedding vector. In this example, we have multiple levels of information, where similarities can be defined along the abstraction levels but also across different levels. Using a categorical colormap to differentiate the topic groups would not allow for enough nuance to express similarities for the other levels.

Generally speaking, for text visualizations, we often want to depict the following relations using color: (1) the similarity across computed categories and groupings, e.g., topics or entities; (2) the similarity between keywords, n-grams, and word vectors; and (3) the similarity between a category and a keyword. An effective color assignment would allow for the investigation of these three types of relationships, facilitating the localization of individual attributes based on their color, as well as the comparison of different attributes.

To address this challenge, in this paper, we propose a guideline for semantic color mapping. It is described in the form of a pipeline that deduces best practices from several color assignment experiments and literature. We showcase the applicability of the proposed guideline in the context of text visualization applications in Sect. 4.

**Contribution** - We contribute a detailed description of the multi-stage process of semantic color mapping and a discussion of lessons learned, and best practices based on two application scenarios.

---

## 2 RELATED WORK

Color considerations for text can often be seen using the context of the case or task at hand in combination with semantic resonant colors of words. Semantic resonant colors map object words to their real-world colors, e.g., yellow for banana or blue for sky. Based on the assumption that meaningful colored words improve task solving performance, Lin et al. conducted a study to investigate the hypothesis and propose colors for such context words. They found that semantic resonant color assignment significantly improves the chart reading time in their study. An example using semantic resonant colors for words or, in this case, categories is NEREX. They use such resonant colors to support users in exploring entity graphs.

Not only are semantic resonant colors favorable in some situations, but other features are also essential for some situations without, e.g., meaningful resonant colors for words or in which the semantic resonant colors do not include the context of the task correctly. Gramazio et al. present various metrics with which a color scale can be generated, neglecting semantic resonant colors for words. But, their metrics could be further extended using such resonant colors to generate more meaningful color maps, including the context for words. Also, other considerations like the affection for colors are crucial properties for users. Bartram et al. demonstrate how small changes for color maps can steer the affection of colors for users into calm and positive. An extension of the technique with additional colors can lead to more focused semantic resonant colors.

Towards extending previous color scales, Steiger et al. evaluate various 2D color maps for their usage as spatial color scales. They use various measures to investigate which properties the selected 2D color maps support for further analysis tasks in user applications. For example, Buchmüller et al. use the previously discovered properties and further investigate the possibility of applying these color maps to fish swarms for collective behavior analysis. Primarily, 2D color maps with white or black in the center are unfavorable for such a task. When combining the previous considerations, we have to focus on the related work towards spatial color maps. Thus, such a finding is essential for 2D color maps in spatial tasks like those presented in this paper using 2D or 3D projections.

Sect. 3 presents all stages of our proposed pipeline in detail, incorporating further related work of each stage. Due to the scope of the paper, we do not include an extensive overview of color perception or color assignment research beyond the presented considerations and examples. However, our first introductory related work gives a few considerations for text and the use of colors for them. We identify a need for a semantic color mapping pipeline for 2D or 3D projections of words considering semantic resonant colors or spatial color maps to investigate the differences in the projections. The proposed pipeline in this work is further inspired by the arguments for enhancing the relative comparison of data objects using two-dimensional color assignments.

---

## 3 SEMANTIC COLOR MAPPING PIPELINE

In order to structure the design space, we present a pipeline encompassing the necessary steps to get from available data to semantic color labels. Fig. 1 shows the four distinct steps of the workflow we identified: (1) Aggregating the underlying data in a task-dependent way; (2) choosing a method for transforming the aggregated text data into numerical vector representations (3) choosing an appropriate unit of analysis; and subsequently (4) applying a projection method. Finally, we can (5) apply the resulting coordinates onto a color map. At each step of the pipeline, we have a set of available design choices which influence the outcome. In the following section, we want to briefly highlight the key design considerations and possibilities.

**Methodology** - This paper aims to structure best practices and design consideration for color assignment in visual text analytics applications. To come up with the proposed pipeline, we first identified a set of available methods from literature, as discussed in the previous section. Second, we analyzed the properties and characteristics of available methods. Lastly, based on our experience, extensive discussions, and literature reviews, we came up with the pipeline and collection of methods at each step. This paper points out task-specific considerations, which are further exemplified in application scenarios in Sect. 4.

**Pipeline Dependencies** - This section describes each step of the proposed pipeline independently. However, as the steps are not independent, we also provide considerations for the design as a guideline. That being said, further research and studies are needed to map out the best practices for design choices of pipeline steps.

### 3.1 Aggregation Level & Vector Representations

Text data can be analyzed in different granularity levels, depending on the use case at hand. The granularity levels typically include words/tokens, sentences, utterances, paragraphs, etc. On the token level, methods such as YAKE allow the automatic extraction of important keywords from the textual data. Independent on the used level, its representation is usually numeric, captured in the form of a (potentially) high-dimensional vector. The reason is the ability to apply machine learning methods to such a numerical input. In the following, we showcase different forms of a vector representation that can be used to characterize text data.

* 
**Input**: Raw or labeled data.


* 
**Output**: Aggregated data.


* 
**Design Choices**: Aggregation levels, e.g., token/word, sentence, paragraph, document.


* 
**Dependencies**: Analysis task.



There are multiple ways of representing text through high-dimensional vectors. We can use one of the early approaches that include One-Hot Encoding Vectors that encode word occurrence in a document and Count Vectors that encode word frequency. Different weighting techniques such as Term Frequency - Inverse Document Frequency (TF-IDF) can be used to represent the word's importance in a document amongst a collection of documents. These early approaches represent words in a standalone manner though, i.e., the vectors do not encode any relationship between them.

To represent word relationships, one can use more recent approaches that are built on a different learning assumption, i.e., words that occur in the same context are similar and thus should be represented through similar vectors. This principle is used in, e.g., Co-Occurrence Vectors and neural network based learning techniques such as Word2Vec or ConceptNet. The latter produces static word embeddings capturing the words' meaning, but lacks the ability to distinguish between polysemous words (words with multiple meanings).

The most recent advances in NLP are deep-learning-based language models (e.g., BERT) that produce contextualized word embeddings, i.e., a unique embedding vector for each word's occurrence in the context. Before using contextualized word embeddings in a text application, we first need to make several analysis-related decisions. Language model architectures typically consist of multiple layers. Since the information that gets captured in the different layers varies, one has to decide which layer is appropriate for a given use case. We can use embedding vectors from one specific layer or combine embeddings from multiple layers by averaging or concatenating them. For some use cases, one can also extract embeddings from context-size zero, which sometimes are used as replacements for static embeddings.

The list of possible vector representations does not end with the development of language models, though. Depending on the application scenario, one can create further representation encodings, e.g., topic distributions as well as diverse scoring techniques that capture text characteristics, or use WordNet embeddings that are built from semantic networks. For other granularity levels, we might need to either average word level vectors or come up with new alternatives. For instance, to represent sentences, we can use neural networks that produce sentence embeddings.

* 
**Input**: Aggregated text data.


* 
**Output**: High-dimensional vectors.


* 
**Design Choices**: Traditional document vectors, static word embeddings, contextualized word embeddings, sentence embeddings, topic distributions, WordNet.


* 
**Dependencies**: Aggregation level.



### 3.2 Unit of Analysis & Projection Methods

The following step is the translation from potentially high-dimensional vector representations into low-dimensional 2D or 3D coordinates. Besides choosing the actual dimensionality reduction method, we also have to consider the task-dependent unit of analysis. Based on our intended task, we need to apply a secondary aggregation step to combine vector representations into topics, concepts, or sentiments. For example, we might average the vectors of multiple tokens belonging to a concept to get a shared score representation for the whole concept. Alternatively, we may aggregate the 2D/3D coordinates after the dimensionality-reduction step. Later in this section, we discuss that the second approach is beneficiary if we have a growing data corpus.

* 
**Input**: High-dimensional vectors.


* 
**Output**: Aggregated sets of vector data.


* 
**Design Choices**: Aggregation based on chosen unit of interest, e.g. topic.


* 
**Dependencies**: Aggregation level, task.



To translate the high-dimensional vectors into low-dimensional 1D/2D or 3D coordinates, we have the choice between a wide range of available projection techniques. Methods can be classified based on two main characteristics: linearity and preservation of neighborhood. Linear methods are simple, computationally efficient, and easy to interpret, but cannot capture distributions in complex higher-dimensional manifolds. Non-linear ones require more careful optimization of parameters, but work better for complex manifolds. Depending on the output of the previous step, one also has to consider that different projection methods are applicable to different input types: Either high-dimensional samples, or an available distance metric. One might therefore choose a method based on the availability of respective input data from the previous step. Many methods can be used with high-dimensional input samples, but well-known approaches like MDS, t-SNE, and UMAP only require an available distance metric.

A prime example of a linear and global method is Principal Component Analysis (PCA). MDS is the most well-known global and non-linear method. As the term suggests, the advantage of both methods is that they preserve global structure at the possible expense of local discriminability. In particular, one might expect good global coverage of the space, but similar data points might be projected onto very similar coordinates, and might therefore not be easily distinguishable from each other. Methods like t-SNE, UMAP or PBC are part of the non-linear and local methods. These methods are better at untangling local structures at the expense of global structural fidelity. This trade-off between global consistency and local discriminability might depend on the particular task. A recent surveys finds that PBC, t-SNE, UMAP and IDMAP produce consistently good results, both quantitatively and in terms of human perception, for 2D projections. Another survey found that t-SNE, UMAP and neural auto encoder-based approaches produce the best results for 3D projections.

When the tasks demand adding additional data points over time, e.g., for progressive topic modeling, we want to ensure continued stability of the 2D projection, which requires that we do not recompute the whole embedding, but instead embed additional data points into an existing embedding. Especially for non-linear embedding and projection methods, averaging vector representations can lead to larger jumps in the projected coordinates. Therefore, it is preferable to average the final low-dimensional projected coordinates instead. This ensures higher stability of the resulting coordinates and subsequent colors. As a final post-processing step, we can apply a linear transformation like stretching along coordinate axes to fit the resulting projection to the shape of the chosen color space, e.g., a 2D rectangular color map, or a three-dimensional complex color space.

* 
**Input**: Set of high-dimensional numeric vector representations.


* 
**Output**: 2D/3D coordinate per input.


* 
**Design Choices**: Local vs. global, linear vs. non-linear embedding methods, algorithm hyperparameters.


* 
**Dependencies**: Vector representations, color space.



### 3.3 Color Mapping

In the next step, a color map is created, so that each of the projected 2D points is matched with a color. Zhou et al. give a general overview of color spaces in visualization. Compared to the traditional use case of color maps in, e.g., scatter plots, the color in a semantic color map does not encode an external attribute such as frequency or importance. Instead, it only represents the similarity of points in the projection space, usually using the euclidean distance. Choosing an appropriate color space is essential for extracting a good semantic color map from it. Many different color spaces, such as RGB, HSV, CIELab can be used to represent color values. For a semantic mapping, the colors of the color space should represent the similarity between projection points, meaning that close-by projection points are represented using colors that are perceived as similar. To be able to distinguish points that are far away, the space needs to contain many distinguishable colors - therefore the extracted 2D map should cover many different hues, and not be restricted to, e.g., only purple and greens.

Once an appropriate color space is found, we still need to create a mapping from the color space to the projection space. The easiest way to create such a map is to take a slice of the higher dimensional color space to create a fixed 2D color map. Steiger et al. offer a visual tool for the exploration of different precomputed 2D color maps. They introduce multiple quantitative measures, e.g., perceived color distance, and color map properties such as perceptual linearity and number of distinguishable colors. Bremm et al. employ a 2D semantic color map to compare descriptors, and base it on a slice of the RGB color cube, as their goal was to have high-contrast colors. Steiger et al. use four colors as corner points and interpolate between them to create a 2D color map. Each corner of the 2D map is assigned a color, equalized across intensity and saturation, and all other positions are interpolated using the CIELab color space. We will present two 2D example applications using semantic color maps in Section 3.

One big challenge for creating these semantic color maps is that simply taking a slice of a 3D color space cube might result in areas where the saturation is very low or uneven. Further, different color hues at the same saturation level are perceived differently by humans, as observed by Steiger et al.. The outline of the 2D projection does not necessarily have to be a rectangle or ellipse it could also contain empty regions without points. To keep regions of the projection space as separated as possible, it might make sense to sample the color map to match the distribution of the projection. Adaptive sampling of the color space, as proposed by Koutrouli et al. or Nardini et al., allows for more evenly perceived saturation levels on most positions on the 2D map. It also helps to maintain small but well-distinguishable regions on the map, with smooth transitions between regions. Adaptive color maps can also support users that might be afflicted with vision-based deficiencies, as suggested by Waldin et al..

* 
**Input**: 2D/3D coordinate per input.


* 
**Output**: Color per coordinate.


* 
**Design Choices**: Color space (e.g., RGB, HSV, CIELab), color perception (e.g., proximity, cultural meaning), space coverage.


* 
**Dependencies**: Coordinate positions, task.



---

## 4 APPLICATION SCENARIOS

In the following, we present two application examples that utilize the proposed semantic color mapping pipeline.

### 4.1 Semantic Concept Spaces

In Semantic Concept Spaces, we proposed a tool to visualize concepts and their topics in a unified space. The goal was to create a semantic concept space visualization using 2D projections of word embeddings. Words from a given corpus were filtered based on their Part-Of-Speech tags, enriched with semantically similar words, on the token level. We extracted vector embeddings for all tokens using ConceptNet. All collected words were then projected to 2D using t-SNE. As we also wanted to visualize the relation between topics and their descriptive keywords, topics were represented using the embeddings of a selection of the topics' important keywords, by aggregating the t-SNE positions to a single position for each topic.

Using an agglomerate hierarchical clustering, words were aggregated based on their 2D position and high-dimensional similarity, and assigned to a concept hierarchy of three ranks. Words on the highest rank were represented using gray color, and used to create Voronoi cells that indicate global groups of concepts. Each concept of the middle rank was assigned a color, based on an underlying 2D semantic color map. We chose a slice of the CIELab color space, at a luminosity of 60 percent, similar to Steiger et al.. Words in the lower ranks (keywords) inherited the color of their parent concept. On one hand, this allowed users to quickly see which concepts are similar to each other, as close concepts have similar colors. On the other hand, keywords might have another color than their direct neighbors, showing then a mismatch between the high-dimensional similarity of words and their closeness according to the 2D projection. The concept space showing all three hierarchy ranks can be observed in Fig. 2.

### 4.2 Topic Model Icicle

We implemented a visual analytics system for continuous topic model refinement in a streaming system. The main visualization is shown in Fig. 3. To determine topic colors, we start at the token level, extracting the top 20 keywords using YAKE. We chose to operate on the token-level as topics are typically evaluated through their descriptive keywords-hence, we wanted keyword changes to be reflected in the topic's color. We then extract DistilBert embeddings for the descriptor keywords, and project them onto the color map by Bremm et al. using UMAP. To determine the final topic color, we compute the weighted average position of the topic's keywords, using the YAKE keyword scores as weights.

We aggregate the UMAP positions rather than the DistilBert vectors to ensure that the final result is within the bounds of the previously computed UMAP projection. To optimize the color assignment, we remove frequent, domain-specific keywords with little semantic information, which has two benefits. First, it reduces potential distortion in the UMAP projection by reducing the number of data points. Second, removing semantically uninteresting words means that the limited number of available colors can be better distributed across the available topics. First, it ensures that keywords with more descriptive content can be projected with less distortion. Second, it keeps these keywords from taking up room in the color map and leaves more colors available for other keywords and concepts.

---

## 5 DISCUSSION

Based on our experience utilizing semantic color mapping in the presented applications, in this section, we discuss important design considerations and best practices.

### 5.1 Design Considerations

We discuss three design considerations for the pipeline.

* 
**Task Support**: The main consideration for using the proposed pipeline is to figure out which tasks can be supported by using such color mapping. In particular, which unit of analysis will be used to anchor the color assignment and how is the data distributed for this analysis level, i.e., are there distinct clusters, etc.


* 
**Unit of Analysis Distribution**: One of the decisive criteria for the effectiveness of the color assignment is the distribution of the attributes that are mapped to color. If the attributes do not equally cover distinct areas in the color space, then the resulting visualization will not make full use of the available colors. In particular, if the attributes are mainly clustered in the middle of the space, they might end up being assigned a non-expressive color, e.g., gray or white. On the other hand, having balanced clustered throughout the space can result in meaningful color mapping, which, in turn, could be the basis of a discrete or categorical color assignment.


* 
**Subjective Similarity**: Color distances and similarities are subjective, culture-dependent, and perception-dependent. Considering for whom, where, and in which context a visualization is designed, is crucial for the choice of color space. In some languages and cultures, certain color shades can not be distinguished or named as easily as in others, influencing the detection of differences in color assignment. Taking such issues into account will determine the inclusivity, accessibility, and effectiveness of the visual design.



### 5.2 Best Practices

We discuss three best practices based on our application experiences.

* 
**Projection and Color Space Match**: To make use of the full spectrum of the color space, the projection (shape) has to match the color space (shape). If they do not align, some areas of the color space might not be covered by any data points, such as in Fig. 3. To address such issues, rotating and scaling the projection or the color space to align them could allow for a better use of available colors.


* 
**Incremental or Streaming Analysis**: In many applications, objects could be progressively added to the visualization. Thus, visualization designers need to consider how adding objects to the projection space would skew the vectorization and color mapping. For example, the new vectors might be projected outside the color space, or they might end up cluttered in one area, e.g., in the middle of the color space. Recalculating the last steps of the semantic color mapping pipeline would solve this issue, but cause a discontinuation to the existing colors in the visualization. Allowing for manually triggering color reassignments could avoid issues resulting from continuously adding objects to the color space.


* 
**Color Perception**: One of the most important issues to consider when using this pipeline is that some objects might be mapped close to each other in the space, resulting in color similarities below the just-noticeable-difference. In addition, due to perception issues, such as color blindness and others, users might face difficulties distinguishing areas in the used color space. Allowing users to choose from a list of colormaps would empower them to pick the best perspective based on their understanding and perception.



---

## 6 CONCLUSION

In this paper, we have presented a pipeline for semantic color mapping, as a guideline for meaningful color assignment in visual text analytics applications. Our proposed approach is based on a multi-step process that starts with a task-based extraction of labels from the text data; followed by the determination of the aggregation level to generate vector representations; afterward, we define the unit of analysis to aggregate and project the vectors; finally, the projection is used for a color assignment based on given color space. In addition, this paper presented two application scenarios that utilize the proposed pipeline. Finally, we concluded with a discussion of design considerations and best practices to guide users.

In the future, we plan to operationalize the proposed pipeline by implementing it as a service or library to support practitioners to implement our identified considerations in their works. In addition, we aim to study the design considerations and tradeoffs of users directly in a user study. The study empirically can show the influence of semantic resonant colors for words against the spatial differences of 2D color maps. Thus, such a study can provide guidance for text visualization designers based on empirical results. These results can be further investigated and improve the design considerations and best practices for the proposed pipeline with additional operationalization in the to-be-developed service or library.

---

Would you like me to summarize any specific sections or explain any of the methods discussed in the pipeline?